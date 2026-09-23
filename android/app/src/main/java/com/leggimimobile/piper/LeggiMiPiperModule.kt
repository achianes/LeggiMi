package com.leggimimobile.piper

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.Future
import kotlin.math.max
import kotlin.math.min

/**
 * Neural voices on the phone: Piper (VITS) models run by sherpa-onnx.
 * One sentence at a time is synthesised on a worker thread and played with
 * an AudioTrack; the next sentence can be prepared while one is playing so
 * there is no gap. Events: piper-progress (approximate word being spoken),
 * piper-finish, piper-cancel, piper-error, piper-file-progress.
 */
class LeggiMiPiperModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "LeggiMiPiper"

    private val synth = Executors.newSingleThreadExecutor()   // model loading + synthesis
    private val player = Executors.newSingleThreadExecutor()  // playback queue
    private var tts: OfflineTts? = null
    private var ttsDir = ""
    private val pending = HashMap<String, Future<GeneratedAudio>>()
    @Volatile private var cancelToken = 0
    @Volatile private var track: AudioTrack? = null
    @Volatile private var lastLevelAt = 0L

    private fun emit(name: String, body: Any?) {
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, body)
        } catch (_: Exception) {}
    }

    // ------------------------------------------------------------- voice packages

    /** Unpacks a voice archive (.tar.bz2 from the sherpa-onnx releases) into `dest`; resolves the model folder. */
    @ReactMethod
    fun extract(archive: String, dest: String, promise: Promise) {
        synth.execute {
            try {
                File(dest).mkdirs()
                var top: String? = null
                BufferedInputStream(FileInputStream(archive)).use { raw ->
                    BZip2CompressorInputStream(raw).use { bz ->
                        TarArchiveInputStream(bz).use { tar ->
                            while (true) {
                                val e = tar.nextEntry ?: break
                                val name = e.name.trimStart('/', '.')
                                if (name.isEmpty() || name.contains("..")) continue
                                if (top == null) top = name.substringBefore('/')
                                val out = File(dest, name)
                                if (e.isDirectory) { out.mkdirs(); continue }
                                out.parentFile?.mkdirs()
                                FileOutputStream(out).use { fo ->
                                    val buf = ByteArray(1 shl 16)
                                    while (true) {
                                        val n = tar.read(buf)
                                        if (n < 0) break
                                        fo.write(buf, 0, n)
                                    }
                                }
                            }
                        }
                    }
                }
                val folder = File(dest, top ?: "")
                if (top == null || findModel(folder) == null) throw Exception("No voice model inside the archive")
                promise.resolve(folder.absolutePath)
            } catch (e: Exception) {
                Log.w(TAG, "extract failed", e)
                promise.reject("extract", e.message ?: "extract failed", e)
            }
        }
    }

    private fun findModel(dir: File): File? =
        dir.listFiles()?.firstOrNull { it.isFile && it.name.endsWith(".onnx") }

    /** Loads the voice in `dir` (idempotent). Resolves { sampleRate, numSpeakers }. */
    @ReactMethod
    fun load(dir: String, promise: Promise) {
        synth.execute {
            try {
                if (tts != null && ttsDir == dir) {
                    promise.resolve(info())
                    return@execute
                }
                val folder = File(dir)
                val model = findModel(folder) ?: throw Exception("Voice model not found in $dir")
                val tokens = File(folder, "tokens.txt")
                val data = File(folder, "espeak-ng-data")
                if (!tokens.exists()) throw Exception("tokens.txt missing")
                val cores = Runtime.getRuntime().availableProcessors()
                val config = OfflineTtsConfig(
                    model = OfflineTtsModelConfig(
                        vits = OfflineTtsVitsModelConfig(
                            model = model.absolutePath,
                            tokens = tokens.absolutePath,
                            dataDir = if (data.isDirectory) data.absolutePath else "",
                        ),
                        numThreads = max(2, min(4, cores / 2)),
                        debug = false,
                        provider = "cpu",
                    ),
                    maxNumSentences = 1,
                )
                tts?.free()
                tts = null
                pending.clear()
                tts = OfflineTts(config = config)
                ttsDir = dir
                promise.resolve(info())
            } catch (e: Throwable) {
                Log.w(TAG, "load failed", e)
                promise.reject("load", e.message ?: "cannot load the voice", e)
            }
        }
    }

    private fun info() = Arguments.createMap().apply {
        putInt("sampleRate", tts?.sampleRate() ?: 0)
        putInt("numSpeakers", tts?.numSpeakers() ?: 0)
    }

    @ReactMethod
    fun unload(promise: Promise) {
        synth.execute {
            try { tts?.free() } catch (_: Exception) {}
            tts = null
            ttsDir = ""
            pending.clear()
            promise.resolve(true)
        }
    }

    // ------------------------------------------------------------- speaking

    private fun generate(text: String, speed: Float): GeneratedAudio {
        val t = tts ?: throw Exception("No voice loaded")
        return t.generate(text, 0, speed)
    }

    /** Synthesises `text` ahead of time under `id`; `speak` with the same id plays it at once. */
    @ReactMethod
    fun prepare(id: String, text: String, speed: Double) {
        synchronized(pending) {
            if (pending.containsKey(id)) return
            if (pending.size >= 3) pending.keys.firstOrNull()?.let { pending.remove(it) }
            pending[id] = synth.submit<GeneratedAudio> { generate(text, speed.toFloat()) }
        }
    }

    /** Plays `text` (or the audio prepared under `id`); completion arrives as an event. */
    @ReactMethod
    fun speak(id: String, text: String, speed: Double, promise: Promise) {
        val token = ++cancelToken
        promise.resolve(true)
        player.execute {
            try {
                val fut = synchronized(pending) { pending.remove(id) }
                    ?: synth.submit<GeneratedAudio> { generate(text, speed.toFloat()) }
                val audio = fut.get()
                if (token != cancelToken) { emit("piper-cancel", id); return@execute }
                play(id, text, audio, token)
            } catch (e: Throwable) {
                Log.w(TAG, "speak failed", e)
                emit("piper-error", Arguments.createMap().apply { putString("id", id); putString("message", e.cause?.message ?: e.message ?: "speech failed") })
            }
        }
    }

    private fun play(id: String, text: String, audio: GeneratedAudio, token: Int) {
        val samples = audio.samples
        val total = samples.size
        if (total == 0) { emit("piper-finish", id); return }
        val rate = audio.sampleRate
        val minBuf = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val bufBytes = max(minBuf, rate * 4 / 2) // half a second
        val at = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .setSampleRate(rate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(bufBytes)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        track = at
        val words = wordSpans(text)
        var lastWord = -1
        var cancelled = false
        try {
            at.play()
            var off = 0
            val chunk = 2048
            while (off < total) {
                if (token != cancelToken) { cancelled = true; break }
                val n = min(chunk, total - off)
                val w = at.write(samples, off, n, AudioTrack.WRITE_BLOCKING)
                if (w < 0) throw Exception("AudioTrack write error $w")
                // loudness of what is about to play, for the waveform in the app
                var acc = 0f
                for (k in off until off + w) acc += samples[k] * samples[k]
                val now = System.currentTimeMillis()
                if (now - lastLevelAt > 50) {
                    lastLevelAt = now
                    emit("piper-level", Math.sqrt((acc / max(1, w)).toDouble()).toFloat())
                }
                off += w
                lastWord = reportWord(id, text, words, at.playbackHeadPosition, total, lastWord)
            }
            // drain: wait for the last samples to come out of the speaker
            var idle = 0
            while (!cancelled && at.playbackHeadPosition < total && idle < 200) {
                if (token != cancelToken) { cancelled = true; break }
                Thread.sleep(30)
                idle++
                lastWord = reportWord(id, text, words, at.playbackHeadPosition, total, lastWord)
            }
        } finally {
            try { at.pause(); at.flush(); at.stop() } catch (_: Exception) {}
            try { at.release() } catch (_: Exception) {}
            if (track === at) track = null
        }
        emit(if (cancelled) "piper-cancel" else "piper-finish", id)
    }

    /** [start, end) of each word, to guess the word being spoken from the playback position */
    private fun wordSpans(text: String): List<IntArray> {
        val out = ArrayList<IntArray>()
        var i = 0
        while (i < text.length) {
            while (i < text.length && text[i].isWhitespace()) i++
            val s = i
            while (i < text.length && !text[i].isWhitespace()) i++
            if (i > s) out.add(intArrayOf(s, i))
        }
        return out
    }

    private fun reportWord(id: String, text: String, words: List<IntArray>, head: Int, total: Int, last: Int): Int {
        if (words.isEmpty() || total <= 0) return last
        val frac = head.toDouble() / total
        val pos = (frac * text.length).toInt()
        var idx = words.indexOfFirst { pos < it[1] }
        if (idx < 0) idx = words.size - 1
        if (idx == last) return last
        val w = words[idx]
        emit("piper-progress", Arguments.createMap().apply {
            putString("id", id); putInt("location", w[0]); putInt("length", w[1] - w[0])
        })
        return idx
    }

    /** Stops what is playing and forgets prepared audio. */
    @ReactMethod
    fun stop(promise: Promise) {
        cancelToken++
        synchronized(pending) { pending.clear() }
        try { track?.pause(); track?.flush() } catch (_: Exception) {}
        promise.resolve(true)
    }

    // ------------------------------------------------------------- audiobook

    /** Synthesises every text into one 16-bit WAV (0.4 s of silence between them). */
    @ReactMethod
    fun synthesizeToWav(texts: ReadableArray, speed: Double, out: String, promise: Promise) {
        val token = ++cancelToken
        synth.execute {
            try {
                val t = tts ?: throw Exception("No voice loaded")
                val rate = t.sampleRate()
                val gap = ByteArray((rate * 0.4).toInt() * 2)
                RandomAccessFile(out, "rw").use { f ->
                    f.setLength(0)
                    f.write(ByteArray(44)) // header written at the end
                    var dataBytes = 0L
                    val n = texts.size()
                    for (k in 0 until n) {
                        if (token != cancelToken) throw Exception("Cancelled")
                        val text = texts.getString(k) ?: ""
                        if (text.isBlank()) continue
                        val a = t.generate(text, 0, speed.toFloat())
                        val bb = ByteBuffer.allocate(a.samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
                        for (s in a.samples) {
                            val v = (s.coerceIn(-1f, 1f) * 32767f).toInt()
                            bb.putShort(v.toShort())
                        }
                        f.write(bb.array())
                        f.write(gap)
                        dataBytes += bb.array().size + gap.size
                        emit("piper-file-progress", Arguments.createMap().apply { putInt("done", k + 1); putInt("total", n) })
                    }
                    f.seek(0)
                    f.write(wavHeader(dataBytes, rate))
                }
                promise.resolve(out)
            } catch (e: Throwable) {
                try { File(out).delete() } catch (_: Exception) {}
                val msg = e.cause?.message ?: e.message ?: "synthesis failed"
                promise.reject(if (msg == "Cancelled") "cancelled" else "synth", msg, e)
            }
        }
    }

    /** WAV → AAC (.m4a), the file people keep on the phone or in the cloud */
    @ReactMethod
    fun encodeToM4a(wav: String, out: String, promise: Promise) {
        synth.execute {
            try {
                File(out).delete()
                AacEncoder.wavToM4a(File(wav), File(out))
                promise.resolve(out)
            } catch (e: Throwable) {
                try { File(out).delete() } catch (_: Exception) {}
                promise.reject("encode", e.message ?: "audio encoding failed", e)
            }
        }
    }

    private fun wavHeader(dataBytes: Long, rate: Int): ByteArray {
        val b = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        b.put("RIFF".toByteArray()); b.putInt((36 + dataBytes).toInt()); b.put("WAVE".toByteArray())
        b.put("fmt ".toByteArray()); b.putInt(16); b.putShort(1); b.putShort(1)
        b.putInt(rate); b.putInt(rate * 2); b.putShort(2); b.putShort(16)
        b.put("data".toByteArray()); b.putInt(dataBytes.toInt())
        return b.array()
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    companion object { private const val TAG = "LeggiMiPiper" }
}
