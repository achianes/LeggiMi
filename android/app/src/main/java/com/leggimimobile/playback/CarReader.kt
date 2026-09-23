package com.leggimimobile.playback

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min

/**
 * Reads a Library document without the app's JavaScript running: Android Auto
 * (or a headset button) presses Play while the app is closed, and this reads
 * the cached sentences of the document with the chosen voice, keeping the
 * position in files/auto/progress.json so the app picks it up later.
 *
 * Files written by the app:
 *  - files/auto/<hash>.json   { id, name, segments: [..], chapters: [{title,start}] }
 *  - files/auto/voice.json    { piperDir: "…" | null, rate: 1.0 }
 */
class CarReader(private val ctx: Context, private val onState: (CarReader) -> Unit) {

    companion object { private const val TAG = "LeggiMiCar" }

    private val worker = Executors.newSingleThreadExecutor()
    private val dir get() = File(ctx.filesDir, "auto")

    var docId: String? = null; private set
    var docName: String = ""; private set
    var index: Int = 0; private set
    var total: Int = 0; private set
    var chapter: String = ""; private set
    @Volatile var playing = false; private set
    val active get() = docId != null

    private var segments: List<String> = emptyList()
    private var chapters: List<Pair<String, Int>> = emptyList()
    @Volatile private var token = 0

    // ---- voices
    private var piper: OfflineTts? = null
    private var piperDir: String? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var rate = 1.0f
    @Volatile private var track: AudioTrack? = null

    private fun hash(s: String): String {
        var h = 0
        for (c in s) h = (h * 31 + c.code) or 0
        return java.lang.Long.toHexString(h.toLong() and 0xffffffffL)
    }

    /** the most recently read document that has a cache, from auto_library.json */
    fun lastDocId(): String? {
        try {
            val arr = JSONArray(File(ctx.filesDir, LeggiMiPlaybackService.AUTO_LIBRARY_FILE).readText())
            for (i in 0 until arr.length()) {
                val id = arr.getJSONObject(i).optString("id")
                if (id.isNotEmpty() && File(dir, "${hash(id)}.json").exists()) return id
            }
        } catch (e: Exception) { Log.w(TAG, "auto_library: ${e.message}") }
        // no index (or none of its entries cached): the most recent cache in the folder
        val files = dir.listFiles()?.filter { it.name.endsWith(".json") && it.name != "voice.json" && it.name != "progress.json" }
        Log.i(TAG, "caches in ${dir.absolutePath}: ${files?.size ?: -1}")
        val newest = files?.maxByOrNull { it.lastModified() } ?: return null
        return try { JSONObject(newest.readText()).optString("id").ifEmpty { null } } catch (_: Exception) { null }
    }

    fun hasCache(id: String) = File(dir, "${hash(id)}.json").exists()

    private fun loadVoice() {
        try {
            val v = JSONObject(File(dir, "voice.json").readText())
            rate = v.optDouble("rate", 1.0).toFloat().coerceIn(0.5f, 2.0f)
            val pd = v.optString("piperDir", "")
            piperDir = if (pd.isNotEmpty() && File(pd, "tokens.txt").exists()) pd else null
        } catch (_: Exception) { piperDir = null }
    }

    private fun ensurePiper(): OfflineTts? {
        val pd = piperDir ?: return null
        piper?.let { return it }
        return try {
            val folder = File(pd)
            val model = folder.listFiles()?.firstOrNull { it.name.endsWith(".onnx") } ?: return null
            val data = File(folder, "espeak-ng-data")
            val cfg = OfflineTtsConfig(
                model = OfflineTtsModelConfig(
                    vits = OfflineTtsVitsModelConfig(
                        model = model.absolutePath,
                        tokens = File(folder, "tokens.txt").absolutePath,
                        dataDir = if (data.isDirectory) data.absolutePath else "",
                    ),
                    numThreads = max(2, min(4, Runtime.getRuntime().availableProcessors() / 2)),
                    provider = "cpu",
                ),
                maxNumSentences = 1,
            )
            OfflineTts(config = cfg).also { piper = it }
        } catch (e: Throwable) { Log.w(TAG, "piper", e); null }
    }

    private fun ensureTts(): TextToSpeech? {
        tts?.let { if (ttsReady) return it }
        val latch = CountDownLatch(1)
        var ok = false
        val t = TextToSpeech(ctx) { status -> ok = status == TextToSpeech.SUCCESS; latch.countDown() }
        latch.await(6, TimeUnit.SECONDS)
        if (!ok) { try { t.shutdown() } catch (_: Exception) {}; return null }
        try { t.language = Locale.getDefault() } catch (_: Exception) {}
        t.setSpeechRate(rate)
        tts = t; ttsReady = true
        return t
    }

    /** loads the document (or keeps the current one) and starts from its saved position */
    fun play(id: String? = null, fromIndex: Int? = null) {
        val target = id ?: docId ?: lastDocId()
        if (target == null) { Log.w(TAG, "play: no cached document yet"); return }
        Log.i(TAG, "play $target from ${fromIndex ?: "saved"}")
        worker.execute {
            try {
                if (target != docId) {
                    val j = JSONObject(File(dir, "${hash(target)}.json").readText())
                    val segs = j.getJSONArray("segments")
                    segments = List(segs.length()) { segs.getString(it) }
                    val chs = j.optJSONArray("chapters")
                    chapters = if (chs == null) emptyList() else List(chs.length()) { val c = chs.getJSONObject(it); Pair(c.optString("title"), c.optInt("start")) }
                    docId = target
                    docName = j.optString("name", "LeggiMi")
                    total = segments.size
                    index = fromIndex ?: savedIndex(target)
                }
                if (fromIndex != null) index = fromIndex
                index = index.coerceIn(0, max(0, total - 1))
                loadVoice()
                startLoop()
            } catch (e: Exception) { Log.w(TAG, "play", e) }
        }
    }

    fun pause() { token++; playing = false; stopAudio(); onState(this); saveProgress() }

    fun stop() {
        Log.i(TAG, "stop (was ${if (playing) "playing" else "idle"} at $index)")
        token++; playing = false; stopAudio(); saveProgress()
        docId = null; segments = emptyList(); total = 0; chapter = ""
        onState(this)
    }

    fun skip(delta: Int) {
        if (!active) return
        val wasPlaying = playing
        token++; stopAudio()
        index = (index + delta).coerceIn(0, max(0, total - 1))
        saveProgress(); onState(this)
        if (wasPlaying) worker.execute { startLoop() }
    }

    private fun startLoop() {
        val my = ++token
        playing = true
        onState(this)
        while (my == token && index < total) {
            chapter = chapters.lastOrNull { it.second <= index }?.first ?: ""
            onState(this)
            saveProgress()
            val text = segments[index].trim()
            if (text.isNotEmpty()) speak(text, my)
            if (my != token) return
            index++
        }
        if (my == token) { playing = false; index = min(index, max(0, total - 1)); saveProgress(); onState(this) }
    }

    private fun speak(text: String, my: Int) {
        val p = ensurePiper()
        if (p != null) { speakPiper(p, text, my); return }
        val t = ensureTts() ?: run { Thread.sleep(500); return }
        val latch = CountDownLatch(1)
        t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) { latch.countDown() }
            @Deprecated("Deprecated in Java") override fun onError(utteranceId: String?) { latch.countDown() }
        })
        t.setSpeechRate(rate)
        t.speak(text, TextToSpeech.QUEUE_FLUSH, null, "car-$my-$index")
        while (my == token && !latch.await(100, TimeUnit.MILLISECONDS)) { /* wait */ }
        if (my != token) try { t.stop() } catch (_: Exception) {}
    }

    private fun speakPiper(p: OfflineTts, text: String, my: Int) {
        val audio = try { p.generate(text, 0, rate) } catch (e: Throwable) { Log.w(TAG, "generate", e); return }
        if (my != token || audio.samples.isEmpty()) return
        val rateHz = audio.sampleRate
        val minBuf = AudioTrack.getMinBufferSize(rateHz, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val at = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(rateHz).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(max(minBuf, rateHz * 2))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        track = at
        try {
            at.play()
            var off = 0
            val total = audio.samples.size
            while (off < total && my == token) {
                val n = min(2048, total - off)
                val w = at.write(audio.samples, off, n, AudioTrack.WRITE_BLOCKING)
                if (w < 0) break
                off += w
            }
            var idle = 0
            while (my == token && at.playbackHeadPosition < total && idle < 200) { Thread.sleep(30); idle++ }
        } catch (e: Exception) { Log.w(TAG, "audio", e) }
        finally {
            try { at.pause(); at.flush(); at.stop() } catch (_: Exception) {}
            try { at.release() } catch (_: Exception) {}
            if (track === at) track = null
        }
    }

    private fun stopAudio() {
        try { track?.pause(); track?.flush() } catch (_: Exception) {}
        try { tts?.stop() } catch (_: Exception) {}
    }

    // ---- progress shared with the app
    private fun progressFile() = File(dir, "progress.json")

    private fun savedIndex(id: String): Int = try {
        JSONObject(progressFile().readText()).optJSONObject("docs")?.optJSONObject(id)?.optInt("index", 0) ?: 0
    } catch (_: Exception) { 0 }

    @Synchronized private fun saveProgress() {
        val id = docId ?: return
        try {
            dir.mkdirs()
            val root = try { JSONObject(progressFile().readText()) } catch (_: Exception) { JSONObject() }
            val docs = root.optJSONObject("docs") ?: JSONObject().also { root.put("docs", it) }
            docs.put(id, JSONObject().put("index", index).put("total", total).put("at", System.currentTimeMillis()))
            progressFile().writeText(root.toString())
        } catch (e: Exception) { Log.w(TAG, "progress", e) }
    }

    fun release() {
        token++; stopAudio()
        try { piper?.free() } catch (_: Exception) {}
        piper = null
        try { tts?.shutdown() } catch (_: Exception) {}
        tts = null; ttsReady = false
        worker.shutdownNow()
    }
}
