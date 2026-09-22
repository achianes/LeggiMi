package com.leggimimobile.scan

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import com.leggimimobile.cloud.LeggiMiCloudModule
import com.leggimimobile.playback.LeggiMiPlaybackModule
import com.leggimimobile.piper.LeggiMiPiperModule
import com.leggimimobile.live.LeggiMiLiveModule
import com.leggimimobile.translate.LeggiMiTranslateModule

class LeggiMiScanPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(LeggiMiScanModule(reactContext), LeggiMiCloudModule(reactContext), LeggiMiPlaybackModule(reactContext), LeggiMiPiperModule(reactContext), LeggiMiLiveModule(reactContext), LeggiMiTranslateModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
