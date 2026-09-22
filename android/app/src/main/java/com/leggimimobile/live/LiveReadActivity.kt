package com.leggimimobile.live

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.Executors

/**
 * Live reading: the camera preview with on-device text recognition running on
 * the frames. When the recognised text is stable for a moment and differs from
 * what was last handed out, it goes to [LeggiMiLiveModule] which lets the app
 * read it aloud with the chosen voice. The activity itself never speaks.
 */
class LiveReadActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_AUTO = "auto"
        /** text that is stable on screen and new: to be read */
        @Volatile var onText: ((String) -> Unit)? = null
        /** the activity closed; the string is everything that was handed out, in order */
        @Volatile var onDone: ((String) -> Unit)? = null
    }

    private lateinit var preview: PreviewView
    private lateinit var overlay: TextView
    private lateinit var status: TextView
    private lateinit var autoBtn: Button
    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    private var auto = true
    private var lastFrameAt = 0L
    private var candidate = ""
    private var candidateHits = 0
    private var lastSent = ""
    private val handed = StringBuilder()
    @Volatile private var latest = ""
    private var paused = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        auto = intent.getBooleanExtra(EXTRA_AUTO, true)

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        preview = PreviewView(this).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE }
        root.addView(preview, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        val dp = resources.displayMetrics.density
        status = TextView(this).apply {
            text = "Point the camera at some text"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setBackgroundColor(0x99000000.toInt())
            setPadding((14 * dp).toInt(), (10 * dp).toInt(), (14 * dp).toInt(), (10 * dp).toInt())
            typeface = Typeface.DEFAULT_BOLD
        }
        root.addView(status, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP).apply {
            topMargin = (48 * dp).toInt()
        })

        overlay = TextView(this).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setBackgroundColor(0xB3000000.toInt())
            setPadding((14 * dp).toInt(), (10 * dp).toInt(), (14 * dp).toInt(), (10 * dp).toInt())
            maxLines = 6
        }
        val bottom = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        bottom.addView(overlay, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(0xE6000000.toInt())
            setPadding((10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt(), (24 * dp).toInt())
        }
        fun btn(label: String, bg: Int, onClick: () -> Unit) = Button(this).apply {
            text = label
            setTextColor(Color.BLACK)
            setBackgroundColor(bg)
            setAllCaps(true)
            typeface = Typeface.DEFAULT_BOLD
            setOnClickListener { onClick() }
        }
        val close = btn("Close", 0xFFFF6B6B.toInt()) { finish() }
        autoBtn = btn(if (auto) "Auto: on" else "Auto: off", 0xFFFFD93D.toInt()) {
            auto = !auto
            autoBtn.text = if (auto) "Auto: on" else "Auto: off"
        }
        val readNow = btn("Read this", 0xFF6BCB77.toInt()) {
            val t = latest
            if (t.isNotBlank()) hand(t, force = true)
        }
        val lp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = (8 * dp).toInt() }
        row.addView(close, lp)
        row.addView(autoBtn, lp)
        row.addView(readNow, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.4f))
        bottom.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        root.addView(bottom, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        setContentView(root)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
        else ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), 71)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 71) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) startCamera()
            else { status.text = "Camera permission is needed"; finish() }
        }
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            val prev = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(analysisExecutor) { img -> analyze(img) }
            try {
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, prev, analysis)
            } catch (e: Exception) {
                runOnUiThread { status.text = "Camera not available: ${e.message}" }
            }
        }, ContextCompat.getMainExecutor(this))
    }

    @SuppressLint("UnsafeOptInUsageError")
    private fun analyze(img: ImageProxy) {
        val now = SystemClock.uptimeMillis()
        if (paused || now - lastFrameAt < 700) { img.close(); return }
        lastFrameAt = now
        val media = img.image
        if (media == null) { img.close(); return }
        val input = InputImage.fromMediaImage(media, img.imageInfo.rotationDegrees)
        recognizer.process(input)
            .addOnSuccessListener { res -> onFrame(res) }
            .addOnCompleteListener { img.close() }
    }

    private fun onFrame(res: Text) {
        // reading order: blocks top to bottom, their lines as they come
        val lines = res.textBlocks
            .sortedBy { it.boundingBox?.top ?: 0 }
            .flatMap { b -> b.lines.map { it.text.trim() } }
            .filter { it.length >= 2 }
        val text = lines.joinToString("\n")
        latest = text
        runOnUiThread {
            overlay.text = if (text.isBlank()) "" else text
            overlay.visibility = if (text.isBlank()) View.GONE else View.VISIBLE
            status.text = when {
                text.isBlank() -> "Point the camera at some text"
                auto -> "Hold still: reading when the text settles"
                else -> "Tap Read this"
            }
        }
        if (text.isBlank()) { candidate = ""; candidateHits = 0; return }
        if (similar(text, candidate) > 0.85) candidateHits++ else { candidate = text; candidateHits = 1 }
        if (auto && candidateHits >= 2) hand(candidate, force = false)
    }

    /** hands the text to the app once; `force` = the Read button, always sends */
    private fun hand(text: String, force: Boolean) {
        if (!force && similar(text, lastSent) > 0.6) return
        lastSent = text
        candidateHits = 0
        if (handed.isNotEmpty()) handed.append("\n\n")
        handed.append(text)
        onText?.invoke(text)
        runOnUiThread { status.text = "Reading…" }
    }

    private fun words(s: String) = s.lowercase().split(Regex("[^\\p{L}\\p{N}]+")).filter { it.length >= 2 }.toSet()

    /** Jaccard similarity of the words, 0..1 */
    private fun similar(a: String, b: String): Double {
        if (a.isBlank() || b.isBlank()) return 0.0
        val wa = words(a); val wb = words(b)
        if (wa.isEmpty() || wb.isEmpty()) return 0.0
        val inter = wa.intersect(wb).size.toDouble()
        return inter / (wa.size + wb.size - inter)
    }

    override fun onPause() { paused = true; super.onPause() }
    override fun onResume() { paused = false; super.onResume() }

    override fun onDestroy() {
        try { recognizer.close() } catch (_: Exception) {}
        analysisExecutor.shutdown()
        onDone?.invoke(handed.toString())
        onDone = null
        onText = null
        super.onDestroy()
    }
}
