package com.leggimimobile.translate

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.nl.languageid.LanguageIdentification
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.TranslateRemoteModel
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * On-device translation (ML Kit). Language packs (~30 MB each) are downloaded
 * once into the app; after that whole documents are translated on the phone,
 * sentence by sentence, without sending a word anywhere.
 */
class LeggiMiTranslateModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "LeggiMiTranslate"

    private val io = Executors.newSingleThreadExecutor()
    @Volatile private var cancelled = false

    private fun emit(name: String, body: Any?) {
        try { ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, body) } catch (_: Exception) {}
    }

    private fun code(tag: String): String =
        TranslateLanguage.fromLanguageTag(tag.lowercase().substringBefore('-')) ?: error("Language '$tag' is not supported")

    /** BCP-47 tag of the text's language ("und" when unsure) */
    @ReactMethod
    fun identify(text: String, promise: Promise) {
        io.execute {
            try {
                val id = LanguageIdentification.getClient()
                val tag = Tasks.await(id.identifyLanguage(text.take(4000)), 20, TimeUnit.SECONDS)
                id.close()
                promise.resolve(tag)
            } catch (e: Exception) {
                promise.reject("identify", e.message ?: "language detection failed", e)
            }
        }
    }

    /** languages whose pack is already on the phone */
    @ReactMethod
    fun downloaded(promise: Promise) {
        io.execute {
            try {
                val models = Tasks.await(RemoteModelManager.getInstance().getDownloadedModels(TranslateRemoteModel::class.java), 20, TimeUnit.SECONDS)
                val arr = Arguments.createArray()
                models.forEach { arr.pushString(it.language) }
                promise.resolve(arr)
            } catch (e: Exception) {
                promise.reject("models", e.message ?: "cannot list the language packs", e)
            }
        }
    }

    /** downloads the packs for `from` and `to` (no-op when present) */
    @ReactMethod
    fun ensure(from: String, to: String, promise: Promise) {
        io.execute {
            try {
                val opts = TranslatorOptions.Builder().setSourceLanguage(code(from)).setTargetLanguage(code(to)).build()
                val t = Translation.getClient(opts)
                Tasks.await(t.downloadModelIfNeeded(DownloadConditions.Builder().build()), 15, TimeUnit.MINUTES)
                t.close()
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("download", e.cause?.message ?: e.message ?: "language pack download failed", e)
            }
        }
    }

    @ReactMethod
    fun deletePack(lang: String, promise: Promise) {
        io.execute {
            try {
                Tasks.await(RemoteModelManager.getInstance().deleteDownloadedModel(TranslateRemoteModel.Builder(code(lang)).build()), 30, TimeUnit.SECONDS)
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("delete", e.message ?: "cannot delete the language pack", e)
            }
        }
    }

    @ReactMethod
    fun cancel(promise: Promise) {
        cancelled = true
        promise.resolve(true)
    }

    /** translates every string in order; progress arrives as "translate-progress" {done,total} */
    @ReactMethod
    fun translate(from: String, to: String, texts: ReadableArray, promise: Promise) {
        cancelled = false
        io.execute {
            var t: Translator? = null
            try {
                val opts = TranslatorOptions.Builder().setSourceLanguage(code(from)).setTargetLanguage(code(to)).build()
                t = Translation.getClient(opts)
                Tasks.await(t.downloadModelIfNeeded(DownloadConditions.Builder().build()), 15, TimeUnit.MINUTES)
                val out = Arguments.createArray()
                val n = texts.size()
                for (i in 0 until n) {
                    if (cancelled) throw Exception("Cancelled")
                    val s = texts.getString(i) ?: ""
                    if (s.isBlank()) { out.pushString(s); continue }
                    val r = Tasks.await(t.translate(s), 60, TimeUnit.SECONDS)
                    out.pushString(r)
                    if (i % 10 == 0 || i == n - 1) {
                        emit("translate-progress", Arguments.createMap().apply { putInt("done", i + 1); putInt("total", n) })
                    }
                }
                promise.resolve(out)
            } catch (e: Exception) {
                val msg = e.cause?.message ?: e.message ?: "translation failed"
                promise.reject(if (msg == "Cancelled") "cancelled" else "translate", msg, e)
            } finally {
                try { t?.close() } catch (_: Exception) {}
            }
        }
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
