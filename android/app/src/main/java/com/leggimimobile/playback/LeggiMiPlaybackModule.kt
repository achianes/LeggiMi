package com.leggimimobile.playback

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/** JS side of [LeggiMiPlaybackService]: show/update/hide the media card, receive its buttons. */
class LeggiMiPlaybackModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "LeggiMiPlayback"

    init {
        LeggiMiPlaybackService.listener = { action ->
            try {
                ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("playback-action", action)
            } catch (_: Exception) {}
        }
    }

    /** show or refresh the card; `playing` also decides audio focus, wake lock and foreground state */
    @ReactMethod
    fun update(title: String, subtitle: String, playing: Boolean, promise: Promise) {
        try {
            val running = LeggiMiPlaybackService.instance
            if (running != null) {
                running.jsTakesOver(title, subtitle, playing)
            } else {
                val i = Intent(ctx, LeggiMiPlaybackService::class.java)
                    .setAction(LeggiMiPlaybackService.ACTION_UPDATE)
                    .putExtra(LeggiMiPlaybackService.EXTRA_TITLE, title)
                    .putExtra(LeggiMiPlaybackService.EXTRA_SUBTITLE, subtitle)
                    .putExtra(LeggiMiPlaybackService.EXTRA_PLAYING, playing)
                if (playing && Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("playback", e.message ?: "playback service", e)
        }
    }

    /** what the car reader is doing, if anything: { docId, index, playing } */
    @ReactMethod
    fun carState(promise: Promise) {
        val (id, index, playing) = LeggiMiPlaybackService.instance?.carState() ?: Triple(null, 0, false)
        val m = com.facebook.react.bridge.Arguments.createMap()
        m.putString("docId", id)
        m.putInt("index", index)
        m.putBoolean("playing", playing)
        promise.resolve(m)
    }

    /** the action Android Auto (or a headset) sent while the app was closed, if any */
    @ReactMethod
    fun pending(promise: Promise) {
        val a = LeggiMiPlaybackService.pendingAction
        LeggiMiPlaybackService.pendingAction = null
        promise.resolve(a)
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try {
            ctx.stopService(Intent(ctx, LeggiMiPlaybackService::class.java))
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("playback", e.message ?: "playback service", e)
        }
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
