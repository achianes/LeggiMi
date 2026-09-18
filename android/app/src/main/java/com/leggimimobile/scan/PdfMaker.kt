package com.leggimimobile.scan

import android.content.Context
import android.graphics.Bitmap
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import kotlin.math.max
import kotlin.math.min

/**
 * A tiny PDF 1.4 writer, just enough for scanned documents:
 *  - "image":      one JPEG per A4 page (embedded as-is with DCTDecode, so files stay small)
 *  - "searchable": the same, plus the OCR lines as invisible text (render mode 3) laid
 *                  exactly over the words, so the PDF can be searched, selected and copied
 *  - "text":       the recognised text only, typeset on A4 pages
 * Text uses the standard Helvetica font with WinAnsi (cp1252) encoding.
 */
object PdfMaker {

    class Line(val text: String, val left: Float, val top: Float, val width: Float, val height: Float)
    class Page(val path: String, val imgW: Int, val imgH: Int, val lines: List<Line>)

    private const val A4W = 595f
    private const val A4H = 842f
    private val NL = 10.toChar().toString()
    private const val BS = 92 // backslash
    private val cp1252: Charset = Charset.forName("windows-1252")

    // Helvetica advance widths (1/1000 em) for ASCII 32..126
    private val HELV = intArrayOf(
        278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
        1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
        333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
        556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
    )

    private fun charWidth(c: Char): Int {
        val code = c.code
        if (code in 32..126) return HELV[code - 32]
        return when (c) {
            'à', 'á', 'â', 'ã', 'ä', 'å', 'è', 'é', 'ê', 'ë', 'ò', 'ó', 'ô', 'õ', 'ö', 'ù', 'ú', 'û', 'ü', 'ñ' -> 556
            'ì', 'í', 'î', 'ï' -> 278
            'À', 'Á', 'Â', 'Ä', 'È', 'É', 'Ê', 'Ë', 'Ò', 'Ó', 'Ô', 'Ö' -> 700
            '’', '‘', '‚' -> 222
            '“', '”', '„' -> 333
            '–' -> 556
            '—' -> 1000
            '…' -> 1000
            '€' -> 556
            else -> 556
        }
    }

    fun textWidth(s: String, size: Float): Float {
        var w = 0
        for (c in s) w += charWidth(c)
        return w * size / 1000f
    }

    /** cp1252 bytes of [s] with PDF string escapes; unknown characters become '?'. */
    private fun pdfString(s: String): ByteArray {
        val enc = cp1252.newEncoder()
            .onMalformedInput(CodingErrorAction.REPLACE)
            .onUnmappableCharacter(CodingErrorAction.REPLACE)
            .replaceWith(byteArrayOf('?'.code.toByte()))
        val clean = s.map { if (it.code < 32) ' ' else it }.joinToString("")
        val bb: ByteBuffer = enc.encode(CharBuffer.wrap(clean))
        val raw = ByteArray(bb.remaining())
        bb.get(raw)
        val out = ByteArrayOutputStream(raw.size + 8)
        out.write('('.code)
        for (b in raw) {
            val v = b.toInt() and 255
            if (v == '('.code || v == ')'.code || v == BS) out.write(BS)
            out.write(v)
        }
        out.write(')'.code)
        return out.toByteArray()
    }

    private fun num(v: Float): String {
        val r = Math.round(v * 100f) / 100f
        return if (r == r.toLong().toFloat()) r.toLong().toString() else r.toString()
    }

    private class Writer(os: OutputStream) {
        private val out = BufferedOutputStream(os, 1 shl 16)
        var pos = 0L
            private set
        val offsets = HashMap<Int, Long>()

        fun bytes(b: ByteArray) {
            out.write(b)
            pos += b.size
        }

        fun str(s: String) = bytes(s.toByteArray(Charsets.ISO_8859_1))

        fun obj(id: Int, body: String) {
            offsets[id] = pos
            str("$id 0 obj$NL$body${NL}endobj$NL")
        }

        fun stream(id: Int, dict: String, data: ByteArray) {
            offsets[id] = pos
            str("$id 0 obj$NL<< $dict /Length ${data.size} >>${NL}stream$NL")
            bytes(data)
            str("${NL}endstream${NL}endobj$NL")
        }

        fun flush() = out.flush()
    }

    private fun jpegOf(ctx: Context, path: String, maxSide: Int, quality: Int): Triple<ByteArray, Int, Int> {
        val bmp = ImageOps.decode(ctx, path, maxSide)
        val bos = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, bos)
        val r = Triple(bos.toByteArray(), bmp.width, bmp.height)
        bmp.recycle()
        return r
    }

    /** Writes the PDF and returns the number of pages. */
    fun write(
        ctx: Context,
        out: String,
        mode: String,
        title: String,
        pages: List<Page>,
        text: String,
        maxSide: Int,
        quality: Int
    ): Int {
        File(out).parentFile?.mkdirs()
        FileOutputStream(out).use { fos ->
            val w = Writer(fos)
            w.str("%PDF-1.4$NL")
            w.bytes(byteArrayOf('%'.code.toByte(), 0xE2.toByte(), 0xE3.toByte(), 0xCF.toByte(), 0xD3.toByte(), 10))

            // 1 catalog, 2 pages, 3 font, 4 bold font, 5 info, then pages
            val pageIds = ArrayList<Int>()
            var next = 6

            val bodies = ArrayList<() -> Unit>()

            if (mode == "text") {
                val laid = layoutText(title, text)
                for (pageLines in laid) {
                    val pid = next++
                    val cid = next++
                    pageIds.add(pid)
                    bodies.add {
                        val cs = ByteArrayOutputStream()
                        fun s(x: String) = cs.write(x.toByteArray(Charsets.ISO_8859_1))
                        for (ln in pageLines) {
                            s("BT /${if (ln.bold) "F2" else "F1"} ${num(ln.size)} Tf 1 0 0 1 ${num(ln.x)} ${num(ln.y)} Tm ")
                            cs.write(pdfString(ln.text))
                            s(" Tj ET$NL")
                        }
                        val data = cs.toByteArray()
                        w.obj(pid, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(A4W)} ${num(A4H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents $cid 0 R >>")
                        w.stream(cid, "", data)
                    }
                }
            } else {
                for (pg in pages) {
                    val pid = next++
                    val cid = next++
                    val iid = next++
                    pageIds.add(pid)
                    bodies.add {
                        val (jpeg, jw, jh) = jpegOf(ctx, pg.path, maxSide, quality)
                        val landscape = jw > jh
                        val pw = if (landscape) A4H else A4W
                        val ph = if (landscape) A4W else A4H
                        val s = min(pw / jw, ph / jh)
                        val dw = jw * s
                        val dh = jh * s
                        val x0 = (pw - dw) / 2f
                        val y0 = (ph - dh) / 2f
                        val cs = ByteArrayOutputStream()
                        fun put(x: String) = cs.write(x.toByteArray(Charsets.ISO_8859_1))
                        put("q ${num(dw)} 0 0 ${num(dh)} ${num(x0)} ${num(y0)} cm /Im0 Do Q$NL")
                        if (mode == "searchable" && pg.imgW > 0 && pg.imgH > 0) {
                            // OCR frames are in the pixels of the rendered page
                            val k = dw / pg.imgW
                            for (ln in pg.lines) {
                                val t = ln.text.trim()
                                if (t.isEmpty() || ln.width <= 0f || ln.height <= 0f) continue
                                val size = max(1f, ln.height * k * 0.86f)
                                val natural = textWidth(t, size)
                                val tz = if (natural > 0f) (ln.width * k / natural * 100f).coerceIn(10f, 600f) else 100f
                                val x = x0 + ln.left * k
                                val y = y0 + dh - (ln.top + ln.height * 0.82f) * k
                                put("BT 3 Tr /F1 ${num(size)} Tf ${num(tz)} Tz 1 0 0 1 ${num(x)} ${num(y)} Tm ")
                                cs.write(pdfString(t))
                                put(" Tj ET$NL")
                            }
                        }
                        w.obj(pid, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pw)} ${num(ph)}] /Resources << /XObject << /Im0 $iid 0 R >> /Font << /F1 3 0 R >> >> /Contents $cid 0 R >>")
                        w.stream(cid, "", cs.toByteArray())
                        w.stream(iid, "/Type /XObject /Subtype /Image /Width $jw /Height $jh /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", jpeg)
                    }
                }
            }

            w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>")
            w.obj(2, "<< /Type /Pages /Kids [${pageIds.joinToString(" ") { "$it 0 R" }}] /Count ${pageIds.size} >>")
            w.obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
            w.obj(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
            run {
                w.offsets[5] = w.pos
                w.str("5 0 obj$NL<< /Title ")
                w.bytes(pdfString(title))
                w.str(" /Producer (LeggiMi) /Creator (LeggiMi scanner) >>${NL}endobj$NL")
            }
            for (b in bodies) b()

            val size = next
            val xref = w.pos
            val sb = StringBuilder()
            sb.append("xref").append(NL).append("0 ").append(size).append(NL)
            sb.append("0000000000 65535 f ").append(NL)
            for (id in 1 until size) {
                val off = w.offsets[id] ?: 0L
                sb.append(String.format("%010d 00000 n ", off)).append(NL)
            }
            sb.append("trailer").append(NL).append("<< /Size ").append(size).append(" /Root 1 0 R /Info 5 0 R >>").append(NL)
            sb.append("startxref").append(NL).append(xref).append(NL).append("%%EOF").append(NL)
            w.str(sb.toString())
            w.flush()
            return pageIds.size
        }
    }

    private class TLine(val text: String, val x: Float, val y: Float, val size: Float, val bold: Boolean)

    /** Word-wraps [text] on A4 with a title on the first page. */
    private fun layoutText(title: String, text: String): List<List<TLine>> {
        val margin = 56f
        val maxW = A4W - margin * 2
        val size = 11f
        val lead = 15.5f
        val pages = ArrayList<List<TLine>>()
        var cur = ArrayList<TLine>()
        var y = A4H - margin

        fun newPage() {
            pages.add(cur)
            cur = ArrayList()
            y = A4H - margin
        }

        if (title.isNotBlank()) {
            val ts = 17f
            var t = title.trim()
            while (textWidth(t, ts) > maxW && t.length > 4) t = t.dropLast(2) + "…"
            y -= ts
            cur.add(TLine(t, margin, y, ts, true))
            y -= ts
        }

        val paragraphs = text.replace(13.toChar().toString(), "").split(NL)
        for (para in paragraphs) {
            val p = para.trim()
            if (p.isEmpty()) {
                y -= lead * 0.6f
                continue
            }
            val heading = p.startsWith("#")
            val body = if (heading) p.trimStart('#').trim() else p
            val fs = if (heading) 13f else size
            val words = body.split(' ').filter { it.isNotEmpty() }
            var line = StringBuilder()
            fun flushLine() {
                if (line.isEmpty()) return
                if (y - lead < margin) newPage()
                y -= lead
                cur.add(TLine(line.toString(), margin, y, fs, heading))
                line = StringBuilder()
            }
            for (wd in words) {
                val candidate = if (line.isEmpty()) wd else "$line $wd"
                if (textWidth(candidate, fs) > maxW && line.isNotEmpty()) {
                    flushLine()
                    line.append(wd)
                } else {
                    line.setLength(0)
                    line.append(candidate)
                }
            }
            flushLine()
            y -= lead * 0.35f
        }
        if (cur.isNotEmpty() || pages.isEmpty()) pages.add(cur)
        return pages
    }
}
