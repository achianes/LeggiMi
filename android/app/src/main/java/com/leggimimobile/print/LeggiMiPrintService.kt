package com.leggimimobile.print

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.print.PrintAttributes
import android.print.PrinterCapabilitiesInfo
import android.print.PrinterId
import android.print.PrinterInfo
import android.printservice.PrintJob
import android.printservice.PrintService
import android.printservice.PrinterDiscoverySession
import android.util.Log
import androidx.core.content.FileProvider
import com.leggimimobile.MainActivity
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * A "printer" that reads aloud. Many Android apps have no Share button but
 * almost all of them can Print: the system renders the content to a PDF and
 * hands it to the selected print service. We store that PDF in the app cache
 * and open it in LeggiMi through the same path a shared file would take.
 *
 * The user must enable the service once: Settings > Connected devices >
 * Connection preferences > Printing > LeggiMi.
 */
class LeggiMiPrintService : PrintService() {

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    override fun onCreatePrinterDiscoverySession(): PrinterDiscoverySession =
        object : PrinterDiscoverySession() {
            override fun onStartPrinterDiscovery(priorityList: MutableList<PrinterId>) {
                addPrinters(listOf(buildPrinter()))
            }
            override fun onStopPrinterDiscovery() {}
            override fun onValidatePrinters(printerIds: MutableList<PrinterId>) {}
            override fun onStartPrinterStateTracking(printerId: PrinterId) {}
            override fun onStopPrinterStateTracking(printerId: PrinterId) {}
            override fun onDestroy() {}
        }

    private fun buildPrinter(): PrinterInfo {
        val id = generatePrinterId(PRINTER_LOCAL_ID)
        val caps = PrinterCapabilitiesInfo.Builder(id)
            .addMediaSize(PrintAttributes.MediaSize.ISO_A4, true)
            .addMediaSize(PrintAttributes.MediaSize.NA_LETTER, false)
            .addResolution(PrintAttributes.Resolution("default", "Default", 300, 300), true)
            .setColorModes(
                PrintAttributes.COLOR_MODE_COLOR or PrintAttributes.COLOR_MODE_MONOCHROME,
                PrintAttributes.COLOR_MODE_COLOR
            )
            .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
            .build()
        return PrinterInfo.Builder(id, PRINTER_NAME, PrinterInfo.STATUS_IDLE)
            .setDescription("Reads the document aloud instead of printing it")
            .setCapabilities(caps)
            .build()
    }

    override fun onPrintJobQueued(printJob: PrintJob) {
        val label = printJob.info.label?.takeIf { it.isNotBlank() } ?: "Printed document"
        if (!printJob.isQueued) return
        printJob.start()
        val pfd = printJob.document.data
        if (pfd == null) {
            printJob.fail("Nothing to read in this print job")
            return
        }
        io.execute {
            try {
                val dir = File(cacheDir, "print").apply { mkdirs() }
                val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
                val safe = label.replace(Regex("[^A-Za-z0-9_. -]+"), "_").take(60)
                val out = File(dir, "Print - $safe ($stamp).pdf")
                FileInputStream(pfd.fileDescriptor).use { input ->
                    FileOutputStream(out).use { output -> input.copyTo(output) }
                }
                try { pfd.close() } catch (_: Exception) {}
                main.post {
                    printJob.complete()
                    openInApp(out)
                }
            } catch (e: Exception) {
                Log.e(TAG, "print job failed", e)
                main.post { printJob.fail(e.message ?: "Could not read the print job") }
            }
        }
    }

    override fun onRequestCancelPrintJob(printJob: PrintJob) {
        printJob.cancel()
    }

    private fun openInApp(file: File) {
        val uri = FileProvider.getUriForFile(this, "$packageName.leggimi.fileprovider", file)
        // Same shape as a file shared from another app: react-native-receive-sharing-intent
        // picks it up (EXTRA_STREAM + DISPLAY_NAME) and the JS side reads it out loud.
        val intent = Intent(Intent.ACTION_SEND).apply {
            setClass(this@LeggiMiPrintService, MainActivity::class.java)
            type = "application/pdf"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, file.nameWithoutExtension)
            putExtra(EXTRA_FROM_PRINT, true)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        // Android 10+ blocks activity starts from a background service
        // ("Background activity launch blocked"). So:
        //  1. leave a note the app reads on its next start/resume (always works),
        //  2. post a tap-to-open notification (needs POST_NOTIFICATIONS on 13+),
        //  3. start the activity directly only when the app is already visible.
        writePendingNote(file)
        if (isAppInForeground()) {
            try { startActivity(intent); return } catch (e: Exception) { Log.w(TAG, "startActivity failed", e) }
        }
        notifyReady(file, intent)
    }

    private fun writePendingNote(file: File) {
        try {
            val note = File(File(cacheDir, "print"), PENDING_FILE)
            val json = "{\"path\":" + jsonString(file.absolutePath) +
                ",\"name\":" + jsonString(file.name) +
                ",\"time\":" + System.currentTimeMillis() + "}"
            note.writeText(json)
        } catch (e: Exception) {
            Log.w(TAG, "pending note failed", e)
        }
    }

    private fun jsonString(v: String): String {
        val bs = 92.toChar()
        val q = 34.toChar()
        val sb = StringBuilder().append(q)
        for (c in v) {
            when (c) {
                q -> sb.append(bs).append(q)
                bs -> sb.append(bs).append(bs)
                10.toChar() -> sb.append(bs).append('n')
                13.toChar() -> sb.append(bs).append('r')
                else -> sb.append(c)
            }
        }
        return sb.append(q).toString()
    }

    private fun isAppInForeground(): Boolean {
        val am = getSystemService(ACTIVITY_SERVICE) as ActivityManager
        val procs = am.runningAppProcesses ?: return false
        return procs.any {
            it.processName == packageName &&
                it.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        }
    }

    private fun notifyReady(file: File, intent: Intent) {
        try {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(CHANNEL_ID, "Printed documents", NotificationManager.IMPORTANCE_HIGH)
                channel.description = "A document printed to LeggiMi is ready to be read aloud"
                nm.createNotificationChannel(channel)
            }
            val reqCode = (System.currentTimeMillis() and 0xffffff).toInt()
            val pi = PendingIntent.getActivity(
                this, reqCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val title = file.nameWithoutExtension.removePrefix("Print - ")
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                Notification.Builder(this, CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(this)
            val n = builder
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("Ready to read: $title")
                .setContentText("Tap to listen in LeggiMi")
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setPriority(Notification.PRIORITY_HIGH)
                .build()
            nm.notify(reqCode, n)
        } catch (e: Exception) {
            Log.w(TAG, "notification failed", e)
        }
    }

    companion object {
        private const val TAG = "LeggiMiPrint"
        private const val PRINTER_LOCAL_ID = "leggimi-reader"
        private const val PRINTER_NAME = "LeggiMi (read aloud)"
        const val EXTRA_FROM_PRINT = "com.leggimimobile.FROM_PRINT"
        const val CHANNEL_ID = "leggimi_print"
        const val PENDING_FILE = "pending.json"
    }
}
