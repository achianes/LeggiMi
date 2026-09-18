package com.leggimimobile.scan

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Decodes any audio file Android can play (mp3, m4a/aac, ogg/opus, flac, amr,
 * wav, 3gp, the audio of a video...) into 16 kHz mono 16-bit PCM WAV, the
 * input whisper.cpp expects. Everything happens on the phone.
 */
object AudioDecoder {

    private const val OUT_RATE = 16000

    class Result(val path: String, val durationMs: Long)

    fun toWav16k(ctx: Context, src: String, out: String): Result {
        val ex = MediaExtractor()
        if (src.startsWith("content:") || src.startsWith("file:")) ex.setDataSource(ctx, Uri.parse(src), null)
        else ex.setDataSource(src)
        var track = -1
        var format: MediaFormat? = null
        for (i in 0 until ex.trackCount) {
            val f = ex.getTrackFormat(i)
            if (f.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) {
                track = i
                format = f
                break
            }
        }
        require(track >= 0 && format != null) { "This file has no audio track" }
        ex.selectTrack(track)
        val mime = format.getString(MediaFormat.KEY_MIME)!!
        val codec = MediaCodec.createDecoderByType(mime)
        codec.configure(format, null, null, 0)
        codec.start()

        var srcRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        var floatPcm = false

        File(out).parentFile?.mkdirs()
        val raf = RandomAccessFile(out, "rw")
        raf.setLength(0)
        raf.write(ByteArray(44))
        var written = 0L // output samples

        // streaming linear resampler state (positions in source-sample units)
        var base = 0L
        var pos = 0.0
        var last = 0f
        val outBuf = ByteBuffer.allocate(1 shl 16).order(ByteOrder.LITTLE_ENDIAN)

        fun flushOut() {
            if (outBuf.position() > 0) {
                raf.write(outBuf.array(), 0, outBuf.position())
                outBuf.clear()
            }
        }

        fun consume(mono: FloatArray, n: Int) {
            if (n == 0) return
            val step = srcRate.toDouble() / OUT_RATE
            // average window as a cheap anti-alias filter when downsampling
            val win = max(0, floor(step / 2).toInt())
            val end = base + n - 1
            while (pos <= end) {
                val i = floor(pos).toLong()
                val frac = (pos - i).toFloat()
                fun at(k: Long): Float = when {
                    k < base -> last
                    k > end -> mono[n - 1]
                    else -> mono[(k - base).toInt()]
                }
                var v = at(i) * (1f - frac) + at(i + 1) * frac
                if (win > 0) {
                    var sum = 0f
                    var cnt = 0
                    var k = i - win
                    while (k <= i + win) {
                        sum += at(k)
                        cnt++
                        k++
                    }
                    v = (v + sum / cnt) / 2f
                }
                val s = (v * 32767f).roundToInt().coerceIn(-32768, 32767)
                if (outBuf.remaining() < 2) flushOut()
                outBuf.putShort(s.toShort())
                written++
                pos += step
            }
            last = mono[n - 1]
            base += n
        }

        val info = MediaCodec.BufferInfo()
        var inputDone = false
        var outputDone = false
        var mono = FloatArray(8192)
        try {
            while (!outputDone) {
                if (!inputDone) {
                    val inIdx = codec.dequeueInputBuffer(10_000)
                    if (inIdx >= 0) {
                        val buf = codec.getInputBuffer(inIdx)!!
                        val size = ex.readSampleData(buf, 0)
                        if (size < 0) {
                            codec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            codec.queueInputBuffer(inIdx, 0, size, ex.sampleTime, 0)
                            ex.advance()
                        }
                    }
                }
                val outIdx = codec.dequeueOutputBuffer(info, 10_000)
                when {
                    outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        val f = codec.outputFormat
                        srcRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                        channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                        floatPcm = f.containsKey(MediaFormat.KEY_PCM_ENCODING) &&
                            f.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
                    }
                    outIdx >= 0 -> {
                        val buf = codec.getOutputBuffer(outIdx)!!
                        buf.position(info.offset)
                        buf.limit(info.offset + info.size)
                        val b = buf.slice().order(ByteOrder.LITTLE_ENDIAN)
                        val bytesPerSample = if (floatPcm) 4 else 2
                        val frames = info.size / (bytesPerSample * max(1, channels))
                        if (mono.size < frames) mono = FloatArray(frames)
                        for (fIdx in 0 until frames) {
                            var acc = 0f
                            for (c in 0 until channels) {
                                acc += if (floatPcm) b.float else b.short / 32768f
                            }
                            mono[fIdx] = acc / channels
                        }
                        consume(mono, frames)
                        codec.releaseOutputBuffer(outIdx, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
                    }
                }
            }
            flushOut()
            // WAV header
            val dataBytes = written * 2
            val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            h.put("RIFF".toByteArray(Charsets.US_ASCII))
            h.putInt((36 + dataBytes).toInt())
            h.put("WAVE".toByteArray(Charsets.US_ASCII))
            h.put("fmt ".toByteArray(Charsets.US_ASCII))
            h.putInt(16)
            h.putShort(1) // PCM
            h.putShort(1) // mono
            h.putInt(OUT_RATE)
            h.putInt(OUT_RATE * 2)
            h.putShort(2)
            h.putShort(16)
            h.put("data".toByteArray(Charsets.US_ASCII))
            h.putInt(dataBytes.toInt())
            raf.seek(0)
            raf.write(h.array())
        } finally {
            try { codec.stop() } catch (_: Exception) {}
            codec.release()
            ex.release()
            raf.close()
        }
        return Result(out, written * 1000 / OUT_RATE)
    }

    @Suppress("unused")
    private fun clamp01(v: Float) = min(1f, max(0f, v))
}
