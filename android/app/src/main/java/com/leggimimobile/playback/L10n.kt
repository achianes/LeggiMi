package com.leggimimobile.playback

import android.content.Context

/** The few words drawn by native code (media card, live reading), in the app's language. */
object L10n {
    private const val PREFS = "leggimi_ui"
    private const val KEY = "lang"

    fun setLang(ctx: Context, lang: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, lang).apply()
    }

    private fun lang(ctx: Context): String {
        val saved = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
        return saved ?: java.util.Locale.getDefault().language
    }

    private val WORDS: Map<String, Map<String, String>> = mapOf(
        "Previous" to mapOf("it" to "Indietro", "es" to "Anterior", "fr" to "Précédent", "de" to "Zurück"),
        "Play" to mapOf("it" to "Play", "es" to "Play", "fr" to "Lecture", "de" to "Abspielen"),
        "Pause" to mapOf("it" to "Pausa", "es" to "Pausa", "fr" to "Pause", "de" to "Pause"),
        "Next" to mapOf("it" to "Avanti", "es" to "Siguiente", "fr" to "Suivant", "de" to "Vor"),
        "Stop" to mapOf("it" to "Stop", "es" to "Parar", "fr" to "Arrêter", "de" to "Stopp"),
        "Reading aloud" to mapOf("it" to "Lettura ad alta voce", "es" to "Lectura en voz alta", "fr" to "Lecture à voix haute", "de" to "Vorlesen"),
        "Controls of the document being read" to mapOf("it" to "Comandi del documento in lettura", "es" to "Controles del documento que se lee", "fr" to "Commandes du document en lecture", "de" to "Steuerung des gelesenen Dokuments"),
        "Close" to mapOf("it" to "Chiudi", "es" to "Cerrar", "fr" to "Fermer", "de" to "Schließen"),
        "Auto: on" to mapOf("it" to "Auto: sì", "es" to "Auto: sí", "fr" to "Auto : oui", "de" to "Auto: an"),
        "Auto: off" to mapOf("it" to "Auto: no", "es" to "Auto: no", "fr" to "Auto : non", "de" to "Auto: aus"),
        "Read this" to mapOf("it" to "Leggi questo", "es" to "Lee esto", "fr" to "Lis ceci", "de" to "Das lesen"),
        "Point the camera at some text" to mapOf("it" to "Inquadra un testo", "es" to "Apunta la cámara a un texto", "fr" to "Vise un texte avec la caméra", "de" to "Richte die Kamera auf einen Text"),
        "Hold still: reading when the text settles" to mapOf("it" to "Fermo: leggo quando il testo è stabile", "es" to "Quieto: leo cuando el texto se estabiliza", "fr" to "Ne bouge pas : je lis quand le texte est stable", "de" to "Stillhalten: ich lese, sobald der Text ruhig ist"),
        "Tap Read this" to mapOf("it" to "Tocca Leggi questo", "es" to "Toca Lee esto", "fr" to "Touche Lis ceci", "de" to "Tippe auf Das lesen"),
        "Reading…" to mapOf("it" to "Leggo…", "es" to "Leyendo…", "fr" to "Lecture…", "de" to "Ich lese…"),
        "Camera permission is needed" to mapOf("it" to "Serve il permesso della fotocamera", "es" to "Hace falta el permiso de la cámara", "fr" to "L'autorisation de la caméra est nécessaire", "de" to "Die Kamera-Berechtigung wird benötigt"),
        "Camera not available" to mapOf("it" to "Fotocamera non disponibile", "es" to "Cámara no disponible", "fr" to "Caméra indisponible", "de" to "Kamera nicht verfügbar"),
    )

    fun t(ctx: Context, en: String): String = WORDS[en]?.get(lang(ctx)) ?: en
}
