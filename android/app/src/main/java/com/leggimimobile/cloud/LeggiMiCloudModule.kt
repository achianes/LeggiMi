package com.leggimimobile.cloud

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import okhttp3.Credentials
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Exports files to the user's cloud, always into a folder called "LeggiMi" and
 * only after checking that there is enough free space.
 *
 *  - WebDAV (Nextcloud, ownCloud, pCloud, Koofr, Yandex Disk, 4shared, NAS...):
 *    user name + password (or app password). Quota via RFC 4331.
 *  - Google Drive: Google sign-in (OAuth, scope drive.file: the app only sees the
 *    files it creates). Quota via about.storageQuota.
 *  - Dropbox: OAuth 2 with PKCE and the user's own app key. Quota via get_space_usage.
 *
 * Secrets (passwords, refresh tokens) are kept by [SecretStore], encrypted with a
 * Keystore key; JS only keeps the account id, the provider and a label.
 */
class LeggiMiCloudModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx), ActivityEventListener {

    private val io = Executors.newSingleThreadExecutor()
    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(300, TimeUnit.SECONDS)
        .build()

    private var googleWaiter: ((String?, String?) -> Unit)? = null

    init {
        ctx.addActivityEventListener(this)
    }

    override fun getName() = "LeggiMiCloud"

    private fun bg(promise: Promise, block: () -> Any?) {
        io.execute {
            try {
                promise.resolve(block())
            } catch (e: Throwable) {
                promise.reject("E_CLOUD", e.message ?: e.toString(), e)
            }
        }
    }

    private class Space(val used: Long, val total: Long, val free: Long)

    private fun spaceMap(id: String, label: String, s: Space?): WritableMap = Arguments.createMap().apply {
        putString("id", id)
        putString("label", label)
        putDouble("used", (s?.used ?: -1L).toDouble())
        putDouble("total", (s?.total ?: -1L).toDouble())
        putDouble("free", (s?.free ?: -1L).toDouble())
    }

    private fun Response.bodyText(): String = body?.string() ?: ""

    private fun fail(r: Response, what: String): Nothing {
        val code = r.code
        val msg = when (code) {
            401 -> "$what: wrong user name or password (or the app password is required)"
            403 -> "$what: access denied"
            404 -> "$what: not found - check the address"
            507 -> "$what: not enough space in the cloud"
            else -> "$what: HTTP $code"
        }
        r.close()
        error(msg)
    }

    private fun checkSpace(s: Space?, bytes: Long) {
        if (s != null && s.free >= 0 && s.free < bytes + 64 * 1024) {
            error("Not enough space in the cloud: ${human(bytes)} needed, ${human(s.free)} free")
        }
    }

    private fun human(n: Long): String = when {
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> "${n / 1024} KB"
        n < 1024L * 1024 * 1024 -> String.format("%.1f MB", n / 1048576.0)
        else -> String.format("%.1f GB", n / 1073741824.0)
    }

    // =============================================================== WebDAV

    private fun davBase(url: String): String {
        var u = url.trim()
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://$u"
        if (!u.endsWith("/")) u += "/"
        return u
    }

    private fun enc(segment: String): String = URLEncoder.encode(segment, "UTF-8").replace("+", "%20")

    private val PROPFIND_QUOTA =
        """<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:quota-available-bytes/><d:quota-used-bytes/></d:prop></d:propfind>"""

    private fun davPropfind(url: String, auth: String): Response =
        http.newCall(
            Request.Builder().url(url)
                .header("Authorization", auth)
                .header("Depth", "0")
                .method("PROPFIND", PROPFIND_QUOTA.toRequestBody("application/xml; charset=utf-8".toMediaType()))
                .build()
        ).execute()

    private fun davNumber(xml: String, prop: String): Long? {
        val m = Regex("$prop[^>]*>[^0-9<-]*(-?[0-9]+)").find(xml) ?: return null
        return m.groupValues[1].toLongOrNull()
    }

    private fun davSpace(xml: String): Space? {
        val free = davNumber(xml, "quota-available-bytes")
        val used = davNumber(xml, "quota-used-bytes")
        if (free == null || free < 0) return null
        val u = used ?: 0L
        return Space(u, if (used != null) free + u else -1, free)
    }

    /** Makes sure base/LeggiMi/ exists; returns its space (or the account's). */
    private fun davEnsureFolder(base: String, auth: String): Space? {
        val folder = base + enc(FOLDER) + "/"
        val r = davPropfind(folder, auth)
        if (r.code == 207 || r.code == 200) {
            val s = davSpace(r.bodyText())
            r.close()
            return s
        }
        if (r.code == 401) fail(r, "Login")
        r.bodyText()
        r.close()
        val mk = http.newCall(
            Request.Builder().url(folder).header("Authorization", auth).method("MKCOL", null).build()
        ).execute()
        if (mk.code !in listOf(201, 200, 405)) fail(mk, "Creating the LeggiMi folder")
        mk.bodyText()
        mk.close()
        val again = davPropfind(folder, auth)
        val s = if (again.code == 207) davSpace(again.bodyText()) else null
        again.close()
        return s
    }

    @ReactMethod
    fun webdavConnect(url: String, user: String, pass: String, label: String, promise: Promise) = bg(promise) {
        val base = davBase(url)
        val auth = Credentials.basic(user, pass, Charsets.UTF_8)
        val r = davPropfind(base, auth)
        if (r.code != 207 && r.code != 200) fail(r, "Connection")
        val accountSpace = davSpace(r.bodyText())
        r.close()
        val folderSpace = davEnsureFolder(base, auth)
        val id = "dav_" + UUID.randomUUID().toString().take(8)
        SecretStore.put(ctx, id, JSONObject().put("type", "webdav").put("url", base).put("user", user).put("pass", pass).toString())
        spaceMap(id, label, folderSpace ?: accountSpace)
    }

    private fun davUpload(sec: JSONObject, file: File, name: String, mime: String): Pair<String, Space?> {
        val base = sec.getString("url")
        val auth = Credentials.basic(sec.getString("user"), sec.getString("pass"), Charsets.UTF_8)
        val space = davEnsureFolder(base, auth)
        checkSpace(space, file.length())
        val folder = base + enc(FOLDER) + "/"
        var target = name
        var n = 2
        while (true) {
            // PROPFIND instead of HEAD: some servers send a body with HEAD answers,
            // which corrupts the next request on a reused connection
            val probe = davPropfind(folder + enc(target), auth)
            val exists = probe.code == 207 || probe.code == 200
            probe.bodyText()
            probe.close()
            if (!exists) break
            target = name.substringBeforeLast('.') + " ($n)." + name.substringAfterLast('.', "pdf")
            n++
        }
        val put = http.newCall(
            Request.Builder().url(folder + enc(target)).header("Authorization", auth)
                .put(file.asRequestBody(mime.toMediaType())).build()
        ).execute()
        if (put.code !in 200..299) fail(put, "Upload")
        put.bodyText()
        put.close()
        return Pair("$FOLDER/$target", davEnsureFolder(base, auth))
    }

    // ========================================================= Google Drive

    private fun googleToken(interactive: Boolean, done: (String?, String?) -> Unit) {
        val activity = ctx.currentActivity
        val req = AuthorizationRequest.builder().setRequestedScopes(listOf(Scope(DRIVE_FILE))).build()
        val client = if (activity != null) Identity.getAuthorizationClient(activity) else Identity.getAuthorizationClient(ctx)
        client.authorize(req)
            .addOnSuccessListener { res ->
                if (res.hasResolution()) {
                    val pi = res.pendingIntent
                    if (!interactive || activity == null || pi == null) {
                        done(null, "Google needs you to sign in again: open Cloud accounts and reconnect Google Drive")
                        return@addOnSuccessListener
                    }
                    googleWaiter = done
                    try {
                        activity.startIntentSenderForResult(pi.intentSender, REQ_GOOGLE, null, 0, 0, 0)
                    } catch (e: Exception) {
                        googleWaiter = null
                        done(null, e.message)
                    }
                } else {
                    done(res.accessToken, null)
                }
            }
            .addOnFailureListener { e ->
                val msg = e.message ?: "Google sign-in failed"
                done(null, if (msg.contains("10:") || msg.contains("DEVELOPER_ERROR")) GOOGLE_SETUP_HINT else msg)
            }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQ_GOOGLE) return
        val w = googleWaiter ?: return
        googleWaiter = null
        if (resultCode != Activity.RESULT_OK) {
            w(null, "cancelled")
            return
        }
        try {
            val res = Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(data)
            w(res.accessToken, null)
        } catch (e: Exception) {
            w(null, e.message ?: "Google sign-in failed")
        }
    }

    override fun onNewIntent(intent: Intent) {}

    private fun gAbout(token: String): Pair<String, Space?> {
        val r = http.newCall(
            Request.Builder()
                .url("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName),storageQuota(limit,usage)")
                .header("Authorization", "Bearer $token").build()
        ).execute()
        if (!r.isSuccessful) fail(r, "Google Drive")
        val j = JSONObject(r.bodyText())
        r.close()
        val email = j.optJSONObject("user")?.optString("emailAddress") ?: ""
        val q = j.optJSONObject("storageQuota")
        val used = q?.optString("usage")?.toLongOrNull() ?: 0L
        val limit = q?.optString("limit")?.toLongOrNull()
        val space = if (limit != null && limit > 0) Space(used, limit, limit - used) else Space(used, -1, -1)
        return Pair(email, space)
    }

    private fun gFolder(token: String): String {
        val q = "name='$FOLDER' and mimeType='application/vnd.google-apps.folder' and trashed=false"
        val r = http.newCall(
            Request.Builder()
                .url("https://www.googleapis.com/drive/v3/files?fields=files(id)&spaces=drive&q=" + URLEncoder.encode(q, "UTF-8"))
                .header("Authorization", "Bearer $token").build()
        ).execute()
        if (!r.isSuccessful) fail(r, "Google Drive")
        val files = JSONObject(r.bodyText()).optJSONArray("files")
        r.close()
        if (files != null && files.length() > 0) return files.getJSONObject(0).getString("id")
        val body = JSONObject().put("name", FOLDER).put("mimeType", "application/vnd.google-apps.folder").toString()
        val c = http.newCall(
            Request.Builder().url("https://www.googleapis.com/drive/v3/files?fields=id")
                .header("Authorization", "Bearer $token")
                .post(body.toRequestBody("application/json; charset=utf-8".toMediaType())).build()
        ).execute()
        if (!c.isSuccessful) fail(c, "Creating the LeggiMi folder")
        val id = JSONObject(c.bodyText()).getString("id")
        c.close()
        return id
    }

    private fun gUpload(token: String, file: File, name: String, mime: String): Space? {
        val (_, space) = gAbout(token)
        checkSpace(space, file.length())
        val folder = gFolder(token)
        val boundary = "leggimi" + UUID.randomUUID().toString().replace("-", "")
        val meta = JSONObject().put("name", name).put("parents", org.json.JSONArray().put(folder)).toString()
        val nl = "" + 13.toChar() + 10.toChar()
        val head = ("--$boundary${nl}Content-Type: application/json; charset=UTF-8$nl$nl$meta$nl" +
            "--$boundary${nl}Content-Type: $mime$nl$nl").toByteArray(Charsets.UTF_8)
        val tail = "$nl--$boundary--$nl".toByteArray(Charsets.UTF_8)
        val body = object : RequestBody() {
            override fun contentType() = "multipart/related; boundary=$boundary".toMediaType()
            override fun contentLength() = head.size + file.length() + tail.size
            override fun writeTo(sink: okio.BufferedSink) {
                sink.write(head)
                file.inputStream().use { input ->
                    val buf = ByteArray(1 shl 16)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        sink.write(buf, 0, n)
                    }
                }
                sink.write(tail)
            }
        }
        val r = http.newCall(
            Request.Builder().url("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name")
                .header("Authorization", "Bearer $token").post(body).build()
        ).execute()
        if (!r.isSuccessful) fail(r, "Upload")
        r.close()
        return gAbout(token).second
    }

    @ReactMethod
    fun googleConnect(promise: Promise) {
        googleToken(true) { token, err ->
            if (token == null) {
                promise.reject("E_GOOGLE", err ?: "Google sign-in failed")
                return@googleToken
            }
            bg(promise) {
                val (email, space) = gAbout(token)
                gFolder(token)
                val id = "gd_" + UUID.randomUUID().toString().take(8)
                SecretStore.put(ctx, id, JSONObject().put("type", "gdrive").put("email", email).toString())
                spaceMap(id, email, space)
            }
        }
    }

    // ============================================================= Dropbox

    private fun b64url(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    /** Sends the user to Dropbox in the browser and catches the answer on http://localhost:53682/. */
    @ReactMethod
    fun dropboxConnect(appKey: String, promise: Promise) {
        val key = appKey.trim()
        if (key.isEmpty()) {
            promise.reject("E_DROPBOX", "Enter the App key of your Dropbox app")
            return
        }
        val rnd = ByteArray(48).also { SecureRandom().nextBytes(it) }
        val verifier = b64url(rnd)
        val challenge = b64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        val state = b64url(ByteArray(16).also { SecureRandom().nextBytes(it) })
        val server = try {
            ServerSocket(DROPBOX_PORT, 1, InetAddress.getByName("127.0.0.1")).apply { soTimeout = 5 * 60 * 1000 }
        } catch (e: Exception) {
            promise.reject("E_DROPBOX", "Port $DROPBOX_PORT is busy: ${e.message}")
            return
        }
        val authUrl = Uri.parse("https://www.dropbox.com/oauth2/authorize").buildUpon()
            .appendQueryParameter("client_id", key)
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("token_access_type", "offline")
            .appendQueryParameter("redirect_uri", DROPBOX_REDIRECT)
            .appendQueryParameter("state", state)
            .build()
        io.execute {
            try {
                val code = server.use { srv ->
                    srv.accept().use { sock ->
                        val line = sock.getInputStream().bufferedReader().readLine() ?: ""
                        val query = line.substringAfter("?", "").substringBefore(" ")
                        val params = query.split("&").mapNotNull {
                            val k = it.substringBefore("=", "")
                            if (k.isEmpty()) null else k to URLDecoder.decode(it.substringAfter("=", ""), "UTF-8")
                        }.toMap()
                        val ok = params["code"] != null && params["state"] == state
                        val nl = "" + 13.toChar() + 10.toChar()
                        val html = "<html><body style='font-family:sans-serif;background:#FFF6E5;padding:40px'><h1>" +
                            (if (ok) "LeggiMi is connected to Dropbox" else "Dropbox did not authorise LeggiMi") +
                            "</h1><p>You can go back to the app.</p></body></html>"
                        val bytes = html.toByteArray(Charsets.UTF_8)
                        sock.getOutputStream().write(
                            ("HTTP/1.1 200 OK${nl}Content-Type: text/html; charset=utf-8${nl}Content-Length: ${bytes.size}${nl}Connection: close$nl$nl")
                                .toByteArray(Charsets.US_ASCII) + bytes
                        )
                        sock.getOutputStream().flush()
                        if (!ok) error(params["error_description"] ?: params["error"] ?: "Dropbox authorisation was refused")
                        params["code"]!!
                    }
                }
                val form = "code=${enc(code)}&grant_type=authorization_code&client_id=${enc(key)}" +
                    "&redirect_uri=${enc(DROPBOX_REDIRECT)}&code_verifier=${enc(verifier)}"
                val r = http.newCall(
                    Request.Builder().url("https://api.dropboxapi.com/oauth2/token")
                        .post(form.toRequestBody("application/x-www-form-urlencoded".toMediaType())).build()
                ).execute()
                if (!r.isSuccessful) fail(r, "Dropbox token")
                val j = JSONObject(r.bodyText())
                r.close()
                val access = j.getString("access_token")
                val refresh = j.optString("refresh_token", "")
                val email = dbxEmail(access)
                dbxFolder(access)
                val space = dbxSpace(access)
                val id = "db_" + UUID.randomUUID().toString().take(8)
                SecretStore.put(ctx, id, JSONObject().put("type", "dropbox").put("appKey", key).put("refresh", refresh).put("email", email).toString())
                promise.resolve(spaceMap(id, email, space))
            } catch (e: Throwable) {
                promise.reject("E_DROPBOX", e.message ?: e.toString(), e)
            }
        }
        val view = Intent(Intent.ACTION_VIEW, authUrl).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            (ctx.currentActivity ?: ctx).startActivity(view)
        } catch (e: Exception) {
            try { server.close() } catch (_: Exception) {}
        }
    }

    private fun dbxAccess(sec: JSONObject): String {
        val form = "grant_type=refresh_token&refresh_token=${enc(sec.getString("refresh"))}&client_id=${enc(sec.getString("appKey"))}"
        val r = http.newCall(
            Request.Builder().url("https://api.dropboxapi.com/oauth2/token")
                .post(form.toRequestBody("application/x-www-form-urlencoded".toMediaType())).build()
        ).execute()
        if (!r.isSuccessful) fail(r, "Dropbox login")
        val t = JSONObject(r.bodyText()).getString("access_token")
        r.close()
        return t
    }

    private fun dbxRpc(token: String, endpoint: String, json: String?): Response {
        val b = Request.Builder().url("https://api.dropboxapi.com/2/$endpoint").header("Authorization", "Bearer $token")
        if (json == null) b.post(ByteArray(0).toRequestBody(null)) else b.post(json.toRequestBody("application/json".toMediaType()))
        return http.newCall(b.build()).execute()
    }

    private fun dbxEmail(token: String): String {
        val r = dbxRpc(token, "users/get_current_account", null)
        if (!r.isSuccessful) fail(r, "Dropbox account")
        val e = JSONObject(r.bodyText()).optString("email", "Dropbox")
        r.close()
        return e
    }

    private fun dbxSpace(token: String): Space? {
        val r = dbxRpc(token, "users/get_space_usage", null)
        if (!r.isSuccessful) { r.close(); return null }
        val j = JSONObject(r.bodyText())
        r.close()
        val used = j.optLong("used", 0)
        val alloc = j.optJSONObject("allocation")?.optLong("allocated", -1) ?: -1
        return if (alloc > 0) Space(used, alloc, alloc - used) else Space(used, -1, -1)
    }

    private fun dbxFolder(token: String) {
        val r = dbxRpc(token, "files/create_folder_v2", JSONObject().put("path", "/$FOLDER").put("autorename", false).toString())
        // 409 = already there
        if (!r.isSuccessful && r.code != 409) fail(r, "Creating the LeggiMi folder")
        r.close()
    }

    /** Dropbox-API-Arg must be pure ASCII: escape everything else as u-sequences. */
    private fun asciiJson(s: String): String {
        val bs = 92.toChar()
        val sb = StringBuilder()
        for (c in s) {
            if (c.code < 127) sb.append(c) else sb.append(bs).append('u').append(String.format("%04x", c.code))
        }
        return sb.toString()
    }

    private fun dbxUpload(sec: JSONObject, file: File, name: String): Pair<String, Space?> {
        val token = dbxAccess(sec)
        checkSpace(dbxSpace(token), file.length())
        dbxFolder(token)
        val arg = asciiJson(JSONObject().put("path", "/$FOLDER/$name").put("mode", "add").put("autorename", true).put("mute", false).toString())
        val r = http.newCall(
            Request.Builder().url("https://content.dropboxapi.com/2/files/upload")
                .header("Authorization", "Bearer $token")
                .header("Dropbox-API-Arg", arg)
                .post(file.asRequestBody("application/octet-stream".toMediaType())).build()
        ).execute()
        if (!r.isSuccessful) fail(r, "Upload")
        val path = JSONObject(r.bodyText()).optString("path_display", "/$FOLDER/$name")
        r.close()
        return Pair(path.trimStart('/'), dbxSpace(token))
    }

    // ============================================================ common

    private fun secret(id: String): JSONObject {
        val raw = SecretStore.get(ctx, id) ?: error("This cloud account is no longer available: add it again")
        return JSONObject(raw)
    }

    /** Free space of an account (-1 = the provider does not tell). */
    @ReactMethod
    fun info(id: String, promise: Promise) {
        val sec = try { secret(id) } catch (e: Exception) { promise.reject("E_CLOUD", e.message); return }
        when (sec.getString("type")) {
            "gdrive" -> googleToken(false) { token, err ->
                if (token == null) promise.reject("E_CLOUD", err ?: "Google sign-in needed")
                else bg(promise) { spaceMap(id, sec.optString("email"), gAbout(token).second) }
            }
            "dropbox" -> bg(promise) { spaceMap(id, sec.optString("email"), dbxSpace(dbxAccess(sec))) }
            else -> bg(promise) {
                val base = sec.getString("url")
                spaceMap(id, sec.optString("user"), davEnsureFolder(base, Credentials.basic(sec.getString("user"), sec.getString("pass"), Charsets.UTF_8)))
            }
        }
    }

    @ReactMethod
    fun upload(id: String, src: String, name: String, mime: String, promise: Promise) {
        val file = File(src.removePrefix("file://"))
        if (!file.exists()) {
            promise.reject("E_CLOUD", "File not found")
            return
        }
        val sec = try { secret(id) } catch (e: Exception) { promise.reject("E_CLOUD", e.message); return }
        fun result(path: String, s: Space?): WritableMap = spaceMap(id, "", s).apply {
            putString("path", path)
            putDouble("bytes", file.length().toDouble())
        }
        when (sec.getString("type")) {
            "gdrive" -> googleToken(true) { token, err ->
                if (token == null) promise.reject("E_CLOUD", err ?: "Google sign-in needed")
                else bg(promise) { result("$FOLDER/$name", gUpload(token, file, name, mime)) }
            }
            "dropbox" -> bg(promise) { val (p, s) = dbxUpload(sec, file, name); result(p, s) }
            else -> bg(promise) { val (p, s) = davUpload(sec, file, name, mime); result(p, s) }
        }
    }

    @ReactMethod
    fun remove(id: String, promise: Promise) {
        SecretStore.remove(ctx, id)
        promise.resolve(true)
    }

    companion object {
        const val FOLDER = "LeggiMi"
        private const val REQ_GOOGLE = 5123
        private const val DRIVE_FILE = "https://www.googleapis.com/auth/drive.file"
        private const val DROPBOX_PORT = 53682
        private const val DROPBOX_REDIRECT = "http://localhost:53682/"
        private const val GOOGLE_SETUP_HINT =
            "Google Drive is not enabled for this build yet: the app must be registered in a Google Cloud project " +
                "(Drive API + an Android OAuth client for com.leggimimobile with the signing certificate SHA-1). See the README."
    }
}
