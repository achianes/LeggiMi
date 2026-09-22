package com.leggimimobile.piper

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.min

/** 16-bit PCM WAV → AAC in an .m4a container, with the phone's hardware/software encoder. */
object AacEncoder {

    private const val MIME = "audio/mp4a-latm"

    fun wavToM4a(wav: File, out: File, bitrate: Int = 64000) {
        RandomAccessFile(wav, "r").use { f ->
            var rate = 22050
            var channels = 1
            var dataPos = 44L
            var dataLen = f.length() - 44
            // walk the RIFF chunks: "fmt " gives rate/channels, "data" the samples
            var pos = 12L
            while (pos + 8 <= f.length()) {
                f.seek(pos)
                val id = ByteArray(4); f.readFully(id)
                val szb = ByteArray(4); f.readFully(szb)
                val sz = ByteBuffer.wrap(szb).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xffffffffL
                when (String(id, Charsets.ISO_8859_1)) {
                    "fmt " -> {
                        val fmt = ByteArray(16); f.readFully(fmt)
                        val bb = ByteBuffer.wrap(fmt).order(ByteOrder.LITTLE_ENDIAN)
                        bb.short // format tag
                        channels = bb.short.toInt()
                        rate = bb.int
                    }
                    "data" -> { dataPos = pos + 8; dataLen = min(sz, f.length() - dataPos); }
                }
                if (String(id, Charsets.ISO_8859_1) == "data") break
                pos += 8 + sz + (sz and 1L)
            }

            val format = MediaFormat.createAudioFormat(MIME, rate, channels).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 1 shl 16)
            }
            val codec = MediaCodec.createEncoderByType(MIME)
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            val muxer = MediaMuxer(out.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            var track = -1
            var muxing = false
            val info = MediaCodec.BufferInfo()
            val bytesPerSec = rate.toLong() * channels * 2
            var pts = 0L
            var remaining = dataLen
            var inputDone = false
            f.seek(dataPos)
            try {
                while (true) {
                    if (!inputDone) {
                        val i = codec.dequeueInputBuffer(10_000)
                        if (i >= 0) {
                            val buf = codec.getInputBuffer(i)!!
                            buf.clear()
                            if (remaining <= 0) {
                                codec.queueInputBuffer(i, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                inputDone = true
                            } else {
                                val n = min(buf.capacity().toLong(), remaining).toInt()
                                val tmp = ByteArray(n)
                                f.readFully(tmp)
                                buf.put(tmp)
                                codec.queueInputBuffer(i, 0, n, pts, 0)
                                pts += n * 1_000_000L / bytesPerSec
                                remaining -= n
                            }
                        }
                    }
                    val o = codec.dequeueOutputBuffer(info, 10_000)
                    if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        track = muxer.addTrack(codec.outputFormat)
                        muxer.start()
                        muxing = true
                    } else if (o >= 0) {
                        val ob = codec.getOutputBuffer(o)!!
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                        if (info.size > 0 && muxing) {
                            ob.position(info.offset)
                            ob.limit(info.offset + info.size)
                            muxer.writeSampleData(track, ob, info)
                        }
                        codec.releaseOutputBuffer(o, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                    }
                }
            } finally {
                try { codec.stop() } catch (_: Exception) {}
                try { codec.release() } catch (_: Exception) {}
                try { if (muxing) muxer.stop() } catch (_: Exception) {}
                try { muxer.release() } catch (_: Exception) {}
            }
        }
    }
}
