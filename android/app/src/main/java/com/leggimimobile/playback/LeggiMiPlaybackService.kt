package com.leggimimobile.playback

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.media.MediaBrowserServiceCompat
import androidx.media.session.MediaButtonReceiver
import org.json.JSONArray
import java.io.File
import com.leggimimobile.MainActivity
import com.leggimimobile.R

/**
 * Keeps the reading alive when the screen is off or another app is in front:
 * a media-style notification with controls (also on the lock screen), a media
 * session for headset buttons, audio focus (pause when a call comes in) and a
 * wake lock. The reading itself stays in JS; this service only reports what the
 * user asked for (play, pause, next, previous, stop) through [listener].
 */
class LeggiMiPlaybackService : MediaBrowserServiceCompat() {

    companion object {
        private const val TAG = "LeggiMiPlayback"
        const val CHANNEL_ID = "leggimi_playback"
        const val NOTIF_ID = 4242
        const val ACTION_PLAY = "com.leggimimobile.playback.PLAY"
        const val ACTION_PAUSE = "com.leggimimobile.playback.PAUSE"
        const val ACTION_NEXT = "com.leggimimobile.playback.NEXT"
        const val ACTION_PREV = "com.leggimimobile.playback.PREV"
        const val ACTION_STOP = "com.leggimimobile.playback.STOP"
        const val ACTION_UPDATE = "com.leggimimobile.playback.UPDATE"
        const val EXTRA_TITLE = "title"
        const val EXTRA_SUBTITLE = "subtitle"
        const val EXTRA_PLAYING = "playing"

        /** set by the React module: receives "play" | "pause" | "next" | "prev" | "stop" | "open:<library id>" */
        @Volatile var listener: ((String) -> Unit)? = null
        @Volatile var instance: LeggiMiPlaybackService? = null
        /** an action that arrived while the app was not running (Android Auto): consumed by JS at start */
        @Volatile var pendingAction: String? = null
        const val ROOT_ID = "leggimi_root"
        /** what the car may ask for when nothing is playing */
        const val IDLE_ACTIONS = PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PLAY_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID or PlaybackStateCompat.ACTION_PLAY_FROM_SEARCH or
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
        const val AUTO_LIBRARY_FILE = "auto_library.json"
    }

    /**
     * Reads without the app when JS is not running (Android Auto with the app
     * closed): the car reader speaks the cached sentences itself. Once the app
     * reads again (applyState from JS with playing=true) it takes over.
     */
    private val car: CarReader by lazy {
        CarReader(this) { r ->
            if (!carOwner) return@CarReader
            val sub = buildString {
                if (r.chapter.isNotEmpty()) append(r.chapter).append(" · ")
                if (r.total > 0) append(((r.index + 1) * 100 / r.total)).append("% · block ").append(r.index + 1).append("/").append(r.total)
            }
            applyState(if (r.docName.isNotEmpty()) r.docName else title, sub, r.playing)
        }
    }
    @Volatile private var carOwner = false
    /** the media card is shown only once something has actually been read in this run */
    @Volatile private var cardWanted = false

    /** Android Auto only binds us; to read with the app closed the service must be started too. */
    private fun ensureStarted() {
        try {
            val i = Intent(this, LeggiMiPlaybackService::class.java)
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
            Log.i(TAG, "started for the car reader")
        } catch (e: Exception) { Log.w(TAG, "cannot start the service", e) }
    }

    /** The app was swiped away from the recent apps: LeggiMi leaves the phone and the car too. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.i(TAG, "task removed: shutting down")
        if (carOwner) try { car.stop() } catch (_: Exception) {}
        carOwner = false
        shutDown()
        super.onTaskRemoved(rootIntent)
    }

    /** Stop pressed or the card swiped away: no card, no session, service gone. */
    private fun shutDown() {
        playing = false
        cardWanted = false
        releaseWake()
        abandonFocus()
        try {
            // stopped, but Play stays available: Android Auto hides every button otherwise
            session.setPlaybackState(PlaybackStateCompat.Builder().setActions(IDLE_ACTIONS).setState(PlaybackStateCompat.STATE_STOPPED, 0, 0f).build())
            session.isActive = false
        } catch (_: Exception) {}
        try { if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true) } catch (_: Exception) {}
        try { (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID) } catch (_: Exception) {}
        stopSelf()
    }

    /** hands an action to JS when it is running, otherwise to the car reader */
    private fun dispatch(action: String) {
        val l = listener
        if (action == "stop") cardWanted = false
        if (l != null && !carOwner) { l(action); if (action == "stop") shutDown(); return }
        if (l == null && (action == "play" || action.startsWith("open:"))) ensureStarted()
        when {
            action == "play" -> { carOwner = true; car.play() }
            action == "pause" -> if (carOwner) car.pause()
            action == "next" -> if (carOwner) car.skip(1)
            action == "prev" -> if (carOwner) car.skip(-1)
            action == "stop" -> { if (carOwner) car.stop(); carOwner = false; shutDown() }
            action.startsWith("open:") -> {
                val id = action.removePrefix("open:")
                if (car.hasCache(id)) { carOwner = true; car.play(id) }
                else if (l != null) l(action)
                else pendingAction = action
            }
        }
        // JS not running and the car reader could not help: remember it for the app's next start
        if (l == null && !carOwner) pendingAction = action
    }

    /** the car reader's state, for the app when it comes back */
    fun carState(): Triple<String?, Int, Boolean> = if (carOwner && car.active) Triple(car.docId, car.index, car.playing) else Triple(null, 0, false)

    // ------------------------------------------------ Android Auto: the browse tree

    override fun onGetRoot(clientPackageName: String, clientUid: Int, rootHints: Bundle?): BrowserRoot? {
        // Android's "resume media" card asks with EXTRA_RECENT: opt out, or the
        // phone keeps offering LeggiMi among the active players after a swipe
        if (rootHints?.getBoolean(BrowserRoot.EXTRA_RECENT) == true) return null
        return BrowserRoot(ROOT_ID, null)
    }

    override fun onLoadChildren(parentId: String, result: Result<MutableList<MediaBrowserCompat.MediaItem>>) {
        val items = mutableListOf<MediaBrowserCompat.MediaItem>()
        if (parentId == ROOT_ID) {
            try {
                val f = File(filesDir, AUTO_LIBRARY_FILE)
                if (f.exists()) {
                    val arr = JSONArray(f.readText())
                    for (i in 0 until arr.length()) {
                        val o = arr.getJSONObject(i)
                        val id = o.optString("id")
                        if (id.isEmpty()) continue
                        val total = o.optInt("total", 0)
                        val index = o.optInt("index", 0)
                        val pct = if (total > 0) ((index + 1) * 100 / total) else 0
                        val kind = o.optString("kind", "").uppercase()
                        val desc = MediaDescriptionCompat.Builder()
                            .setMediaId("doc:$id")
                            .setTitle(o.optString("name"))
                            .setSubtitle(if (total > 0) "$kind - $pct% - block ${index + 1} of $total" else kind)
                            .build()
                        items.add(MediaBrowserCompat.MediaItem(desc, MediaBrowserCompat.MediaItem.FLAG_PLAYABLE))
                    }
                }
            } catch (e: Exception) { Log.w(TAG, "library for Auto", e) }
        }
        result.sendResult(items)
    }

    private lateinit var session: MediaSessionCompat
    private lateinit var audioManager: AudioManager
    private var focusRequest: AudioFocusRequest? = null
    private var hasFocus = false
    private var resumeOnFocusGain = false
    private var wakeLock: PowerManager.WakeLock? = null
    private var title = "LeggiMi"
    private var subtitle = ""
    private var playing = false
    private var noisyRegistered = false

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            // headphones unplugged: nobody wants the book shouted from the speaker
            if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY && playing) listener?.invoke("pause")
        }
    }

    /** when the service itself asked JS to pause because of a focus loss */
    private var focusPauseAt = 0L

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                // another player took over for good: stop here, no automatic resume.
                // Focus is gone: the next Play must ask for it again, or Android 12+
                // keeps our audio faded out.
                hasFocus = false
                resumeOnFocusGain = false
                if (playing) { focusPauseAt = SystemClock.uptimeMillis(); dispatch("pause") }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                // a call, a navigation prompt: pause and come back afterwards
                hasFocus = false
                if (playing) { resumeOnFocusGain = true; focusPauseAt = SystemClock.uptimeMillis(); dispatch("pause") }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                // a notification sound: the system lowers our volume for a moment, keep reading
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                hasFocus = true
                if (resumeOnFocusGain && !playing) { resumeOnFocusGain = false; dispatch("play") }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        createChannel()
        session = MediaSessionCompat(this, "LeggiMi").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() { dispatch("play") }
                override fun onPause() { dispatch("pause") }
                override fun onSkipToNext() { dispatch("next") }
                override fun onSkipToPrevious() { dispatch("prev") }
                override fun onStop() { dispatch("stop") }
                override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) {
                    val id = mediaId?.removePrefix("doc:") ?: return
                    dispatch("open:$id")
                }
                override fun onPlayFromSearch(query: String?, extras: Bundle?) { dispatch("play") }
            })
            // not active until something is read: an active session puts LeggiMi in
            // Android Auto's bar and among the phone's players
            isActive = false
        }
        sessionToken = session.sessionToken
        // Android Auto binds us when the car connects: a session it can talk to,
        // but no card on the phone until something is read
        try {
            session.setPlaybackState(
                PlaybackStateCompat.Builder()
                    .setActions(IDLE_ACTIONS)
                    .setState(PlaybackStateCompat.STATE_STOPPED, 0, 0f)
                    .build()
            )
        } catch (_: Exception) {}
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        MediaButtonReceiver.handleIntent(session, intent)
        when (intent?.action) {
            ACTION_PLAY -> dispatch("play")
            ACTION_PAUSE -> dispatch("pause")
            ACTION_NEXT -> dispatch("next")
            ACTION_PREV -> dispatch("prev")
            ACTION_STOP -> dispatch("stop")
            ACTION_UPDATE -> {
                applyState(
                    intent.getStringExtra(EXTRA_TITLE) ?: title,
                    intent.getStringExtra(EXTRA_SUBTITLE) ?: subtitle,
                    intent.getBooleanExtra(EXTRA_PLAYING, playing)
                )
                return START_NOT_STICKY
            }
        }
        // started as a foreground service for a button: satisfy the 5 s rule, then let the action decide
        if (cardWanted || playing) publish() else if (intent?.action == ACTION_STOP) shutDown() else foregroundBriefly()
        return START_NOT_STICKY
    }

    /** called by JS: the app reads on its own now, the car reader steps back */
    fun jsTakesOver(newTitle: String, newSubtitle: String, newPlaying: Boolean) {
        if (carOwner && newPlaying) { Log.i(TAG, "the app reads now: car reader steps back"); car.stop(); carOwner = false }
        if (!carOwner) applyState(newTitle, newSubtitle, newPlaying)
    }

    fun applyState(newTitle: String, newSubtitle: String, newPlaying: Boolean) {
        title = newTitle
        subtitle = newSubtitle
        // a pause that is not the echo of our own focus-loss pause is the user's:
        // then nothing must resume the reading behind their back
        if (!newPlaying && playing && SystemClock.uptimeMillis() - focusPauseAt > 2500) resumeOnFocusGain = false
        if (newPlaying) resumeOnFocusGain = false
        playing = newPlaying
        if (playing) { cardWanted = true; try { session.isActive = true } catch (_: Exception) {} }
        // foreground first: Android 15 refuses audio focus to an app that is still in the background
        publish()
        if (playing) {
            acquireWake(); registerNoisy()
            if (!requestFocus()) android.os.Handler(mainLooper).postDelayed({ if (playing) requestFocus() }, 400)
        } else releaseWake()
    }

    private fun publish() {
        try {
            val art = artwork()
            session.setMetadata(
                MediaMetadataCompat.Builder()
                    .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, subtitle)
                    .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, "LeggiMi")
                    .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, title)
                    .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, subtitle)
                    .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art)
                    .putBitmap(MediaMetadataCompat.METADATA_KEY_ART, art)
                    .putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, art)
                    .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, -1L)
                    .build()
            )
            val actions = PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_STOP or
                PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID or PlaybackStateCompat.ACTION_PLAY_FROM_SEARCH
            session.setPlaybackState(
                PlaybackStateCompat.Builder()
                    .setActions(actions)
                    .setState(
                        if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                        PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f
                    )
                    .build()
            )
            if (!cardWanted) {
                // nothing read yet (e.g. just bound by Android Auto) or stopped: no card on the phone
                try { (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID) } catch (_: Exception) {}
                return
            }
            val notification = buildNotification()
            if (playing) {
                if (Build.VERSION.SDK_INT >= 29) {
                    startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
                } else {
                    startForeground(NOTIF_ID, notification)
                }
            } else {
                // paused: keep the card (resume from the lock screen), but let it be swiped away
                if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_DETACH) else @Suppress("DEPRECATION") stopForeground(false)
                (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, notification)
            }
        } catch (e: Exception) {
            Log.w(TAG, "publish failed", e)
        }
    }

    /** a card for 5 s rule compliance when started for a button with nothing to show yet */
    private fun foregroundBriefly() {
        try {
            val n = NotificationCompat.Builder(this, CHANNEL_ID).setSmallIcon(R.drawable.ic_stat_leggimi)
                .setContentTitle("LeggiMi").setPriority(NotificationCompat.PRIORITY_LOW).build()
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) else startForeground(NOTIF_ID, n)
            android.os.Handler(mainLooper).postDelayed({ if (!cardWanted && !playing) shutDown() }, 3000)
        } catch (e: Exception) { Log.w(TAG, "foreground", e) }
    }

    // ------------------------------------------------ artwork: what Android Auto can show
    // Media apps cannot draw on the car screen; the cover is the only picture it
    // shows. It is drawn here: the comic waveform (a new shape for every sentence),
    // the title and the chapter.
    private var artKey = ""
    private var artBmp: android.graphics.Bitmap? = null

    private fun artwork(): android.graphics.Bitmap {
        val key = "$title|$subtitle|$playing"
        artBmp?.let { if (key == artKey) return it }
        val size = 320
        val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.RGB_565)
        val c = android.graphics.Canvas(bmp)
        val ink = 0xFF1B1B1F.toInt()
        c.drawColor(if (playing) 0xFFFFD93D.toInt() else 0xFFF4E4C1.toInt())
        val p = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = ink }
        val border = android.graphics.Paint(p).apply { style = android.graphics.Paint.Style.STROKE; strokeWidth = 9f }
        c.drawRoundRect(android.graphics.RectF(6f, 6f, size - 6f, size - 6f), 30f, 30f, border)
        // waveform: a shape of its own for every sentence, flat when paused
        val rnd = java.util.Random(subtitle.hashCode().toLong() * 31 + title.hashCode())
        val bars = 17
        val bw = 10f
        val left = 30f
        val gap = (size - 2 * left - bars * bw) / (bars - 1)
        val cy = size * 0.52f
        for (i in 0 until bars) {
            val mid = 1f - kotlin.math.abs(i - (bars - 1) / 2f) / ((bars - 1) / 2f) * 0.55f
            val h = if (playing) (18f + rnd.nextFloat() * 120f) * mid + 12f else 10f
            val x = left + i * (bw + gap)
            c.drawRoundRect(android.graphics.RectF(x, cy - h / 2, x + bw, cy + h / 2), 5f, 5f, p)
        }
        val tp = android.text.TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            color = ink; textSize = 26f; typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
        val t = android.text.TextUtils.ellipsize(title, tp, size - 56f, android.text.TextUtils.TruncateAt.END).toString()
        c.drawText(t, 28f, 58f, tp)
        val chapter = subtitle.substringBefore(" · ").let { if (it.contains("%")) "" else it }
        if (chapter.isNotEmpty()) {
            val sp = android.text.TextPaint(tp).apply { textSize = 21f; typeface = android.graphics.Typeface.DEFAULT }
            val ch = android.text.TextUtils.ellipsize(chapter, sp, size - 56f, android.text.TextUtils.TruncateAt.END).toString()
            c.drawText(ch, 28f, size - 34f, sp)
        }
        artKey = key
        artBmp = bmp
        return bmp
    }

    private fun pending(action: String): PendingIntent {
        val i = Intent(this, LeggiMiPlaybackService::class.java).setAction(action)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return if (Build.VERSION.SDK_INT >= 26) PendingIntent.getForegroundService(this, action.hashCode(), i, flags)
        else PendingIntent.getService(this, action.hashCode(), i, flags)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val b = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_leggimi)
            .setLargeIcon(artwork())
            .setContentTitle(title)
            .setContentText(subtitle)
            .setContentIntent(open)
            .setDeleteIntent(pending(ACTION_STOP))
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .addAction(android.R.drawable.ic_media_previous, "Previous", pending(ACTION_PREV))
        if (playing) b.addAction(android.R.drawable.ic_media_pause, "Pause", pending(ACTION_PAUSE))
        else b.addAction(android.R.drawable.ic_media_play, "Play", pending(ACTION_PLAY))
        b.addAction(android.R.drawable.ic_media_next, "Next", pending(ACTION_NEXT))
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", pending(ACTION_STOP))
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
        return b.build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(CHANNEL_ID, "Reading aloud", NotificationManager.IMPORTANCE_LOW)
        ch.description = "Controls of the document being read"
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
    }

    private fun requestFocus(): Boolean {
        if (hasFocus) return true
        val res = if (Build.VERSION.SDK_INT >= 26) {
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setOnAudioFocusChangeListener(focusListener)
                .setWillPauseWhenDucked(false)
                .build()
            focusRequest = req
            audioManager.requestAudioFocus(req)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        }
        hasFocus = res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        if (!hasFocus) Log.w(TAG, "audio focus not granted ($res)")
        return hasFocus
    }

    private fun abandonFocus() {
        if (!hasFocus) return
        try {
            if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            else @Suppress("DEPRECATION") audioManager.abandonAudioFocus(focusListener)
        } catch (_: Exception) {}
        hasFocus = false
    }

    private fun acquireWake() {
        if (wakeLock?.isHeld == true) return
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LeggiMi:reading").also {
                it.setReferenceCounted(false)
                it.acquire(6 * 60 * 60 * 1000L) // six hours at most, a safety net
            }
        } catch (e: Exception) { Log.w(TAG, "wake lock", e) }
    }

    private fun releaseWake() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {}
    }

    private fun registerNoisy() {
        if (noisyRegistered) return
        try {
            registerReceiver(noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
            noisyRegistered = true
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        instance = null
        if (carOwner) try { car.release() } catch (_: Exception) {}
        releaseWake()
        abandonFocus()
        if (noisyRegistered) try { unregisterReceiver(noisyReceiver) } catch (_: Exception) {}
        try { session.isActive = false; session.release() } catch (_: Exception) {}
        try { (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID) } catch (_: Exception) {}
        super.onDestroy()
    }
}
