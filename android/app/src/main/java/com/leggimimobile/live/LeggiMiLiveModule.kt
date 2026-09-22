package com.leggimimobile.live

import android.content.Intent
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/** Opens [LiveReadActivity]; recognised text arrives as "live-text" events, the promise resolves when it closes. */
class LeggiMiLiveModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "LeggiMiLive"

    private fun emit(name: String, body: Any?) {
        try { ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, body) } catch (_: Exception) {}
    }

    @ReactMethod
    fun start(auto: Boolean, promise: Promise) {
        val activity = ctx.currentActivity
        if (activity == null) { promise.reject("live", "No activity"); return }
        LiveReadActivity.onText = { t -> emit("live-text", t) }
        LiveReadActivity.onDone = { all -> promise.resolve(all) }
        val i = Intent(ctx, LiveReadActivity::class.java).putExtra(LiveReadActivity.EXTRA_AUTO, auto)
        activity.startActivity(i)
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
