package com.leggimimobile.scan

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.media.ExifInterface
import android.net.Uri
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Image pipeline of the page scanner: decode (EXIF aware), find the sheet,
 * straighten it (perspective warp), rotate, enhance, save.
 *
 * Quadrilaterals are 8 floats, normalised to 0..1, in the order
 * top-left, top-right, bottom-right, bottom-left (x, y pairs).
 */
object ImageOps {

    // ------------------------------------------------------------------ io

    private fun open(ctx: Context, src: String): InputStream =
        if (src.startsWith("content:") || src.startsWith("file:")) {
            ctx.contentResolver.openInputStream(Uri.parse(src)) ?: error("Cannot open $src")
        } else {
            FileInputStream(src)
        }

    fun bounds(ctx: Context, src: String): IntArray {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        open(ctx, src).use { BitmapFactory.decodeStream(it, null, o) }
        return intArrayOf(o.outWidth, o.outHeight)
    }

    private fun exifRotation(ctx: Context, src: String): Int = try {
        open(ctx, src).use {
            when (ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90
                ExifInterface.ORIENTATION_ROTATE_180 -> 180
                ExifInterface.ORIENTATION_ROTATE_270 -> 270
                else -> 0
            }
        }
    } catch (_: Exception) {
        0
    }

    /** Decode with the longest side <= maxSide and the EXIF orientation applied. */
    fun decode(ctx: Context, src: String, maxSide: Int): Bitmap {
        val b = bounds(ctx, src)
        require(b[0] > 0 && b[1] > 0) { "Not an image: $src" }
        var sample = 1
        while (max(b[0], b[1]) / (sample * 2) >= maxSide) sample *= 2
        val o = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        var bmp = open(ctx, src).use { BitmapFactory.decodeStream(it, null, o) } ?: error("Cannot decode $src")
        val longest = max(bmp.width, bmp.height)
        if (longest > maxSide) {
            val s = maxSide.toFloat() / longest
            bmp = swap(bmp, Bitmap.createScaledBitmap(bmp, max(1, (bmp.width * s).roundToInt()), max(1, (bmp.height * s).roundToInt()), true))
        }
        val rot = exifRotation(ctx, src)
        if (rot != 0) bmp = swap(bmp, rotate(bmp, rot))
        return bmp
    }

    fun saveJpeg(bmp: Bitmap, out: String, quality: Int) {
        File(out).parentFile?.mkdirs()
        FileOutputStream(out).use { bmp.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(30, 100), it) }
    }

    /** Returns [b], recycling [a] when it is a different bitmap. */
    fun swap(a: Bitmap, b: Bitmap): Bitmap {
        if (a !== b) a.recycle()
        return b
    }

    // ------------------------------------------------------------ geometry

    fun rotate(src: Bitmap, degrees: Int): Bitmap {
        val d = ((degrees % 360) + 360) % 360
        if (d == 0) return src
        val m = Matrix().apply { postRotate(d.toFloat()) }
        return Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
    }

    fun scaleDown(src: Bitmap, maxSide: Int): Bitmap {
        val longest = max(src.width, src.height)
        if (longest <= maxSide) return src
        val s = maxSide.toFloat() / longest
        return Bitmap.createScaledBitmap(src, max(1, (src.width * s).roundToInt()), max(1, (src.height * s).roundToInt()), true)
    }

    fun isFullFrame(q: FloatArray): Boolean {
        val full = floatArrayOf(0f, 0f, 1f, 0f, 1f, 1f, 0f, 1f)
        for (i in 0 until 8) if (abs(q[i] - full[i]) > 0.004f) return false
        return true
    }

    /** Perspective-correct the quadrilateral [q] into an upright rectangle. */
    fun warp(src: Bitmap, q: FloatArray, maxSide: Int): Bitmap {
        val w = src.width.toFloat()
        val h = src.height.toFloat()
        val p = FloatArray(8) { if (it % 2 == 0) q[it].coerceIn(0f, 1f) * w else q[it].coerceIn(0f, 1f) * h }
        fun d(a: Int, b: Int) = hypot(p[2 * a] - p[2 * b], p[2 * a + 1] - p[2 * b + 1])
        var ow = max(d(0, 1), d(3, 2))
        var oh = max(d(0, 3), d(1, 2))
        if (ow < 8f || oh < 8f) return src
        val s = min(1f, maxSide / max(ow, oh))
        ow *= s
        oh *= s
        val outW = max(1, ow.roundToInt())
        val outH = max(1, oh.roundToInt())
        val m = Matrix()
        val dst = floatArrayOf(0f, 0f, outW.toFloat(), 0f, outW.toFloat(), outH.toFloat(), 0f, outH.toFloat())
        if (!m.setPolyToPoly(p, 0, dst, 0, 4)) return src
        val out = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        c.drawColor(Color.WHITE)
        c.drawBitmap(src, m, Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG or Paint.DITHER_FLAG))
        return out
    }

    // ------------------------------------------------------ sheet detection

    /**
     * Finds the sheet of paper: the largest bright, low-saturation blob
     * (Otsu threshold), its convex hull, and the largest quadrilateral
     * inscribed in that hull. Returns null when nothing convincing is found
     * (then the caller keeps the whole frame).
     */
    fun detectQuad(src: Bitmap): FloatArray? {
        val maxSide = 360
        val s = min(1f, maxSide.toFloat() / max(src.width, src.height))
        val w = max(8, (src.width * s).roundToInt())
        val h = max(8, (src.height * s).roundToInt())
        val small = Bitmap.createScaledBitmap(src, w, h, true)
        val n = w * h
        val px = IntArray(n)
        small.getPixels(px, 0, w, 0, 0, w, h)
        if (small !== src) small.recycle()

        val lum = IntArray(n)
        val hist = IntArray(256)
        for (i in 0 until n) {
            val c = px[i]
            val r = (c shr 16) and 255
            val g = (c shr 8) and 255
            val b = c and 255
            val l = (r * 299 + g * 587 + b * 114) / 1000
            val sat = max(r, max(g, b)) - min(r, min(g, b))
            val v = if (sat > 70) l / 2 else l // paper is white-ish, not coloured
            lum[i] = v
            hist[v]++
        }
        val t = otsu(hist, n)

        // largest 4-connected component above the threshold
        val label = IntArray(n)
        val queue = IntArray(n)
        var cur = 0
        var bestLabel = 0
        var bestSize = 0
        for (start in 0 until n) {
            if (label[start] != 0 || lum[start] <= t) continue
            cur++
            var head = 0
            var tail = 0
            queue[tail++] = start
            label[start] = cur
            while (head < tail) {
                val p = queue[head++]
                val x = p % w
                val y = p / w
                if (x > 0) { val q = p - 1; if (label[q] == 0 && lum[q] > t) { label[q] = cur; queue[tail++] = q } }
                if (x < w - 1) { val q = p + 1; if (label[q] == 0 && lum[q] > t) { label[q] = cur; queue[tail++] = q } }
                if (y > 0) { val q = p - w; if (label[q] == 0 && lum[q] > t) { label[q] = cur; queue[tail++] = q } }
                if (y < h - 1) { val q = p + w; if (label[q] == 0 && lum[q] > t) { label[q] = cur; queue[tail++] = q } }
            }
            if (tail > bestSize) {
                bestSize = tail
                bestLabel = cur
            }
        }
        val frac = bestSize.toFloat() / n
        if (bestLabel == 0 || frac < 0.10f || frac > 0.97f) return null

        // outline points: leftmost and rightmost pixel of every row
        val xs = ArrayList<Int>()
        val ys = ArrayList<Int>()
        for (y in 0 until h) {
            var lx = -1
            var rx = -1
            val row = y * w
            for (x in 0 until w) if (label[row + x] == bestLabel) {
                if (lx < 0) lx = x
                rx = x
            }
            if (lx >= 0) {
                xs.add(lx); ys.add(y)
                if (rx != lx) { xs.add(rx); ys.add(y) }
            }
        }
        var hull = convexHull(xs, ys)
        if (hull.size < 8) return null
        hull = simplify(hull, 48)
        val quad = maxAreaQuad(hull) ?: return null
        if (polyArea(quad) < 0.08 * n) return null

        // order: top-left, top-right, bottom-right, bottom-left
        val cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4.0
        val cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4.0
        val idx = (0 until 4).sortedBy { atan2(quad[2 * it + 1] - cy, quad[2 * it] - cx) }
        val tl = idx.minByOrNull { quad[2 * it] + quad[2 * it + 1] } ?: idx[0]
        val start = idx.indexOf(tl)
        val out = FloatArray(8)
        for (k in 0 until 4) {
            val i = idx[(start + k) % 4]
            out[2 * k] = ((quad[2 * i] + 0.5) / w).toFloat().coerceIn(0f, 1f)
            out[2 * k + 1] = ((quad[2 * i + 1] + 0.5) / h).toFloat().coerceIn(0f, 1f)
        }
        return out
    }

    private fun otsu(hist: IntArray, total: Int): Int {
        var sum = 0.0
        for (i in 0..255) sum += i.toDouble() * hist[i]
        var sumB = 0.0
        var wB = 0
        var best = -1.0
        var th = 127
        for (i in 0..255) {
            wB += hist[i]
            if (wB == 0) continue
            val wF = total - wB
            if (wF == 0) break
            sumB += i.toDouble() * hist[i]
            val mB = sumB / wB
            val mF = (sum - sumB) / wF
            val between = wB.toDouble() * wF * (mB - mF) * (mB - mF)
            if (between > best) {
                best = between
                th = i
            }
        }
        return th
    }

    /** Monotone chain; returns the hull as a flat [x0,y0,x1,y1,...] list, counter-clockwise. */
    private fun convexHull(xs: List<Int>, ys: List<Int>): DoubleArray {
        val order = xs.indices.sortedWith(compareBy({ xs[it] }, { ys[it] }))
        if (order.size < 3) return DoubleArray(0)
        val hull = IntArray(order.size * 2)
        fun cross(o: Int, a: Int, b: Int): Long =
            (xs[a] - xs[o]).toLong() * (ys[b] - ys[o]) - (ys[a] - ys[o]).toLong() * (xs[b] - xs[o])
        var k = 0
        for (i in order) {
            while (k >= 2 && cross(hull[k - 2], hull[k - 1], i) <= 0) k--
            hull[k++] = i
        }
        val lower = k + 1
        for (j in order.size - 2 downTo 0) {
            val i = order[j]
            while (k >= lower && cross(hull[k - 2], hull[k - 1], i) <= 0) k--
            hull[k++] = i
        }
        val m = k - 1
        val out = DoubleArray(m * 2)
        for (i in 0 until m) {
            out[2 * i] = xs[hull[i]].toDouble()
            out[2 * i + 1] = ys[hull[i]].toDouble()
        }
        return out
    }

    /** Drops the flattest hull vertices until at most [limit] remain (corners survive). */
    private fun simplify(poly: DoubleArray, limit: Int): DoubleArray {
        val pts = ArrayList<DoubleArray>()
        for (i in 0 until poly.size / 2) pts.add(doubleArrayOf(poly[2 * i], poly[2 * i + 1]))
        while (pts.size > limit) {
            var bestI = 0
            var bestA = Double.MAX_VALUE
            for (i in pts.indices) {
                val a = pts[(i - 1 + pts.size) % pts.size]
                val b = pts[i]
                val c = pts[(i + 1) % pts.size]
                val area = abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
                if (area < bestA) {
                    bestA = area
                    bestI = i
                }
            }
            pts.removeAt(bestI)
        }
        val out = DoubleArray(pts.size * 2)
        for (i in pts.indices) {
            out[2 * i] = pts[i][0]
            out[2 * i + 1] = pts[i][1]
        }
        return out
    }

    private fun tri(p: DoubleArray, a: Int, b: Int, c: Int): Double =
        abs((p[2 * b] - p[2 * a]) * (p[2 * c + 1] - p[2 * a + 1]) - (p[2 * b + 1] - p[2 * a + 1]) * (p[2 * c] - p[2 * a])) / 2.0

    /** Largest-area quadrilateral whose corners are hull vertices (O(n^3), n <= 48). */
    private fun maxAreaQuad(p: DoubleArray): DoubleArray? {
        val n = p.size / 2
        if (n < 4) return null
        var best = -1.0
        var bi = 0
        var bj = 1
        var bk = 2
        var bl = 3
        for (i in 0 until n) {
            for (k in i + 2 until n) {
                if (n - (k - i) < 2) continue
                var aj = -1.0
                var jj = -1
                for (j in i + 1 until k) {
                    val a = tri(p, i, j, k)
                    if (a > aj) { aj = a; jj = j }
                }
                var al = -1.0
                var ll = -1
                var l = k + 1
                while (l < i + n) {
                    val li = l % n
                    val a = tri(p, k, li, i)
                    if (a > al) { al = a; ll = li }
                    l++
                }
                if (jj < 0 || ll < 0) continue
                if (aj + al > best) {
                    best = aj + al
                    bi = i; bj = jj; bk = k; bl = ll
                }
            }
        }
        if (best <= 0) return null
        return doubleArrayOf(p[2 * bi], p[2 * bi + 1], p[2 * bj], p[2 * bj + 1], p[2 * bk], p[2 * bk + 1], p[2 * bl], p[2 * bl + 1])
    }

    private fun polyArea(q: DoubleArray): Double {
        var a = 0.0
        val n = q.size / 2
        for (i in 0 until n) {
            val j = (i + 1) % n
            a += q[2 * i] * q[2 * j + 1] - q[2 * j] * q[2 * i + 1]
        }
        return abs(a) / 2.0
    }

    // ------------------------------------------------------------- filters

    /**
     * original - as captured
     * magic    - white balance + auto levels + a little more colour (CamScanner's "Magic Color")
     * gray     - greyscale with auto levels
     * bw       - adaptive threshold: crisp black ink on white paper
     * lighten  - brighter midtones for dim photos
     */
    fun filter(src: Bitmap, name: String): Bitmap {
        if (name == "original" || name.isBlank()) return src
        val w = src.width
        val h = src.height
        val n = w * h
        val px = IntArray(n)
        src.getPixels(px, 0, w, 0, 0, w, h)
        when (name) {
            "magic" -> magic(px)
            "gray" -> gray(px)
            "bw" -> bw(px, w, h)
            "lighten" -> lighten(px)
            else -> return src
        }
        val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        out.setPixels(px, 0, w, 0, 0, w, h)
        return out
    }

    private fun percentile(hist: IntArray, total: Int, p: Double): Int {
        val target = (total * p).toLong()
        var acc = 0L
        for (i in 0..255) {
            acc += hist[i]
            if (acc >= target) return i
        }
        return 255
    }

    private fun stretchLut(lo: Int, hi0: Int): IntArray {
        val hi = max(hi0, lo + 60).coerceAtMost(255)
        val span = max(1, hi - lo)
        return IntArray(256) { ((it - lo) * 255 / span).coerceIn(0, 255) }
    }

    private fun magic(px: IntArray) {
        val n = px.size
        val hr = IntArray(256)
        val hg = IntArray(256)
        val hb = IntArray(256)
        for (c in px) {
            hr[(c shr 16) and 255]++
            hg[(c shr 8) and 255]++
            hb[c and 255]++
        }
        // the paper is the bright majority: pushing ~the 92nd percentile to white
        // removes the colour cast of the room light and greys the shadows out
        val lr = stretchLut(percentile(hr, n, 0.01), percentile(hr, n, 0.92))
        val lg = stretchLut(percentile(hg, n, 0.01), percentile(hg, n, 0.92))
        val lb = stretchLut(percentile(hb, n, 0.01), percentile(hb, n, 0.92))
        val sat = 1.3
        for (i in 0 until n) {
            val c = px[i]
            var r = lr[(c shr 16) and 255].toDouble()
            var g = lg[(c shr 8) and 255].toDouble()
            var b = lb[c and 255].toDouble()
            val l = 0.299 * r + 0.587 * g + 0.114 * b
            r = l + (r - l) * sat
            g = l + (g - l) * sat
            b = l + (b - l) * sat
            px[i] = Color.rgb(r.roundToInt().coerceIn(0, 255), g.roundToInt().coerceIn(0, 255), b.roundToInt().coerceIn(0, 255))
        }
    }

    private fun luma(c: Int): Int = (((c shr 16) and 255) * 299 + ((c shr 8) and 255) * 587 + (c and 255) * 114) / 1000

    private fun gray(px: IntArray) {
        val n = px.size
        val hist = IntArray(256)
        for (i in 0 until n) {
            val l = luma(px[i])
            px[i] = l
            hist[l]++
        }
        val lut = stretchLut(percentile(hist, n, 0.01), percentile(hist, n, 0.95))
        for (i in 0 until n) {
            val v = lut[px[i]]
            px[i] = Color.rgb(v, v, v)
        }
    }

    private fun bw(px: IntArray, w: Int, h: Int) {
        val n = w * h
        val g = IntArray(n)
        for (i in 0 until n) g[i] = luma(px[i])
        val r = max(7, min(w, h) / 24)
        // horizontal box sums
        val tmp = IntArray(n)
        for (y in 0 until h) {
            val row = y * w
            var sum = 0
            for (x in 0..min(r, w - 1)) sum += g[row + x]
            for (x in 0 until w) {
                tmp[row + x] = sum
                val add = x + r + 1
                val rem = x - r
                if (add < w) sum += g[row + add]
                if (rem >= 0) sum -= g[row + rem]
            }
        }
        // vertical box sums + threshold (Bradley): ink is darker than 88% of its neighbourhood
        for (x in 0 until w) {
            val cx = min(x + r, w - 1) - max(x - r, 0) + 1
            var sum = 0
            for (y in 0..min(r, h - 1)) sum += tmp[y * w + x]
            for (y in 0 until h) {
                val cy = min(y + r, h - 1) - max(y - r, 0) + 1
                val i = y * w + x
                val mean = sum / (cx * cy)
                px[i] = if (g[i] * 100 < mean * 88) Color.BLACK else Color.WHITE
                val add = y + r + 1
                val rem = y - r
                if (add < h) sum += tmp[add * w + x]
                if (rem >= 0) sum -= tmp[rem * w + x]
            }
        }
    }

    private fun lighten(px: IntArray) {
        val lut = IntArray(256) { (255.0 * (it / 255.0).pow(0.72) + 6).roundToInt().coerceIn(0, 255) }
        for (i in px.indices) {
            val c = px[i]
            px[i] = Color.rgb(lut[(c shr 16) and 255], lut[(c shr 8) and 255], lut[c and 255])
        }
    }
}
