package com.leggimimobile.print

import android.content.Intent
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
        startActivity(intent)
    }

    companion object {
        private const val TAG = "LeggiMiPrint"
        private const val PRINTER_LOCAL_ID = "leggimi-reader"
        private const val PRINTER_NAME = "LeggiMi (read aloud)"
        const val EXTRA_FROM_PRINT = "com.leggimimobile.FROM_PRINT"
    }
}
