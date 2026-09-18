package com.leggimimobile.scan

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.Executors

/**
 * Native side of the LeggiMi page scanner (JS name: LeggiMiScan).
 *  - scan():         Google ML Kit document scanner (camera, auto edges, manual corners,
 *                    filters, stain/finger removal, multi page, gallery import)
 *  - importImage():  EXIF-aware copy of any picture, downscaled
 *  - detect():       finds the sheet in a picture (normalised quadrilateral)
 *  - processPage():  crop + perspective + rotate + filter -> JPEG
 *  - makePdf():      image / searchable / text PDF
 *  - saveToDownloads(), shareFile()
 * Heavy work runs on a single background thread.
 */
class LeggiMiScanModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx), ActivityEventListener {

    private val io = Executors.newSingleThreadExecutor()
    private var scanPromise: Promise? = null

    init {
        ctx.addActivityEventListener(this)
    }

    override fun getName() = "LeggiMiScan"

    private fun bg(promise: Promise, block: () -> Any?) {
        io.execute {
            try {
                promise.resolve(block())
            } catch (e: Throwable) {
                promise.reject("E_SCAN", e.message ?: e.toString(), e)
            }
        }
    }

    private fun sizeMap(path: String, w: Int, h: Int): WritableMap = Arguments.createMap().apply {
        putString("path", path)
        putInt("width", w)
        putInt("height", h)
    }

    // --------------------------------------------------------------- scanner

    @ReactMethod
    fun scan(pageLimit: Int, galleryAllowed: Boolean, promise: Promise) {
        val activity = ctx.currentActivity
        if (activity == null) {
            promise.reject("E_NO_ACTIVITY", "The app is not in the foreground")
            return
        }
        if (scanPromise != null) {
            promise.reject("E_BUSY", "A scan is already running")
            return
        }
        val options = GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(galleryAllowed)
            .setPageLimit(pageLimit.coerceIn(1, 100))
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build()
        scanPromise = promise
        GmsDocumentScanning.getClient(options)
            .getStartScanIntent(activity)
            .addOnSuccessListener { sender ->
                try {
                    activity.startIntentSenderForResult(sender, REQ_SCAN, null, 0, 0, 0)
                } catch (e: Exception) {
                    scanPromise?.reject("E_START", e.message ?: "Cannot start the scanner", e)
                    scanPromise = null
                }
            }
            .addOnFailureListener { e ->
                scanPromise?.reject("E_UNAVAILABLE", e.message ?: "The document scanner is not available on this phone", e)
                scanPromise = null
            }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQ_SCAN) return
        val p = scanPromise ?: return
        scanPromise = null
        if (resultCode != Activity.RESULT_OK) {
            p.reject("E_CANCELLED", "cancelled")
            return
        }
        val result = GmsDocumentScanningResult.fromActivityResultIntent(data)
        val arr = Arguments.createArray()
        result?.pages?.forEach { arr.pushString(it.imageUri.toString()) }
        p.resolve(arr)
    }

    override fun onNewIntent(intent: Intent) {}

    // -------------------------------------------------------------- images

    @ReactMethod
    fun importImage(src: String, out: String, maxSide: Int, promise: Promise) = bg(promise) {
        val bmp = ImageOps.decode(ctx, src, if (maxSide > 0) maxSide else 3000)
        ImageOps.saveJpeg(bmp, out, 92)
        val r = sizeMap(out, bmp.width, bmp.height)
        bmp.recycle()
        r
    }

    @ReactMethod
    fun imageSize(src: String, promise: Promise) = bg(promise) {
        val b = ImageOps.bounds(ctx, src)
        sizeMap(src, b[0], b[1])
    }

    @ReactMethod
    fun detect(src: String, promise: Promise) = bg(promise) {
        val bmp = ImageOps.decode(ctx, src, 1000)
        val q = ImageOps.detectQuad(bmp)
        bmp.recycle()
        if (q == null) null else Arguments.createArray().apply { q.forEach { pushDouble(it.toDouble()) } }
    }

    @ReactMethod
    fun processPage(opts: ReadableMap, promise: Promise) = bg(promise) {
        val src = opts.getString("src") ?: error("src missing")
        val out = opts.getString("out") ?: error("out missing")
        val maxSide = if (opts.hasKey("maxSide")) opts.getInt("maxSide") else 2200
        val quality = if (opts.hasKey("quality")) opts.getInt("quality") else 88
        val rotation = if (opts.hasKey("rotation")) opts.getInt("rotation") else 0
        val filter = if (opts.hasKey("filter")) opts.getString("filter") ?: "original" else "original"
        val quad = if (opts.hasKey("quad") && !opts.isNull("quad")) {
            opts.getArray("quad")?.let { a -> if (a.size() == 8) FloatArray(8) { a.getDouble(it).toFloat() } else null }
        } else null

        var bmp = ImageOps.decode(ctx, src, (maxSide * 1.5).toInt())
        bmp = if (quad != null && !ImageOps.isFullFrame(quad)) {
            ImageOps.swap(bmp, ImageOps.warp(bmp, quad, maxSide))
        } else {
            ImageOps.swap(bmp, ImageOps.scaleDown(bmp, maxSide))
        }
        if (rotation % 360 != 0) bmp = ImageOps.swap(bmp, ImageOps.rotate(bmp, rotation))
        bmp = ImageOps.swap(bmp, ImageOps.filter(bmp, filter))
        ImageOps.saveJpeg(bmp, out, quality)
        val r = sizeMap(out, bmp.width, bmp.height)
        bmp.recycle()
        r
    }

    // ----------------------------------------------------------------- pdf

    @ReactMethod
    fun makePdf(opts: ReadableMap, promise: Promise) = bg(promise) {
        val out = opts.getString("out") ?: error("out missing")
        val mode = opts.getString("mode") ?: "image"
        val title = if (opts.hasKey("title")) opts.getString("title") ?: "" else ""
        val text = if (opts.hasKey("text")) opts.getString("text") ?: "" else ""
        val maxSide = if (opts.hasKey("maxSide")) opts.getInt("maxSide") else 2000
        val quality = if (opts.hasKey("quality")) opts.getInt("quality") else 80
        val pages = ArrayList<PdfMaker.Page>()
        val arr = if (opts.hasKey("pages")) opts.getArray("pages") else null
        if (arr != null) {
            for (i in 0 until arr.size()) {
                val m = arr.getMap(i) ?: continue
                val lines = ArrayList<PdfMaker.Line>()
                val la = if (m.hasKey("lines")) m.getArray("lines") else null
                if (la != null) {
                    for (j in 0 until la.size()) {
                        val l = la.getMap(j) ?: continue
                        lines.add(
                            PdfMaker.Line(
                                l.getString("text") ?: "",
                                l.getDouble("left").toFloat(),
                                l.getDouble("top").toFloat(),
                                l.getDouble("width").toFloat(),
                                l.getDouble("height").toFloat()
                            )
                        )
                    }
                }
                pages.add(
                    PdfMaker.Page(
                        m.getString("path") ?: continue,
                        if (m.hasKey("imgW")) m.getInt("imgW") else 0,
                        if (m.hasKey("imgH")) m.getInt("imgH") else 0,
                        lines
                    )
                )
            }
        }
        val count = PdfMaker.write(ctx, out, mode, title, pages, text, maxSide, quality)
        Arguments.createMap().apply {
            putString("path", out)
            putInt("pages", count)
            putDouble("bytes", File(out).length().toDouble())
        }
    }

    // --------------------------------------------------------------- audio

    @ReactMethod
    fun decodeAudio(src: String, out: String, promise: Promise) = bg(promise) {
        val r = AudioDecoder.toWav16k(ctx, src, out)
        Arguments.createMap().apply {
            putString("path", r.path)
            putDouble("durationMs", r.durationMs.toDouble())
        }
    }

    // ------------------------------------------------------- save & share

    @ReactMethod
    fun saveToDownloads(src: String, displayName: String, mime: String, promise: Promise) = bg(promise) {
        val file = File(src)
        require(file.exists()) { "File not found" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/LeggiMi")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val resolver = ctx.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("Cannot create the file in Downloads")
            resolver.openOutputStream(uri)?.use { os -> FileInputStream(file).use { it.copyTo(os) } } ?: error("Cannot write to Downloads")
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            "Download/LeggiMi/$displayName"
        } else {
            // Android 9 and older: the public Download folder needs WRITE_EXTERNAL_STORAGE
            // (asked by the JS side); without it fall back to the app's own folder
            val granted = ctx.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
            @Suppress("DEPRECATION")
            val base = if (granted) Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            else ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            val dir = File(base, "LeggiMi").apply { mkdirs() }
            var dest = File(dir, displayName)
            var n = 2
            while (dest.exists()) {
                dest = File(dir, displayName.substringBeforeLast('.') + " ($n)." + displayName.substringAfterLast('.', "pdf"))
                n++
            }
            file.copyTo(dest, overwrite = false)
            dest.absolutePath
        }
    }

    @ReactMethod
    fun shareFile(src: String, mime: String, title: String, promise: Promise) {
        try {
            val file = File(src)
            val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".leggimi.fileprovider", file)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, title)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, title).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
            val activity = ctx.currentActivity
            if (activity != null) activity.startActivity(chooser) else ctx.startActivity(chooser)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_SHARE", e.message ?: "Cannot share the file", e)
        }
    }

    companion object {
        private const val REQ_SCAN = 4817
    }
}
