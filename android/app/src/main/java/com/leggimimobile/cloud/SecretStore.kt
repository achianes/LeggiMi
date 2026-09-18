package com.leggimimobile.cloud

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Cloud passwords and tokens, encrypted with an AES-256-GCM key that lives in
 * the Android Keystore (it never leaves the secure hardware and cannot be
 * exported). The JS side never stores or reads a password after connecting.
 */
object SecretStore {
    private const val ALIAS = "leggimi_cloud_secrets"
    private const val PREFS = "leggimi_cloud_secrets"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        kg.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return kg.generateKey()
    }

    fun put(ctx: Context, id: String, value: String) {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val ct = c.doFinal(value.toByteArray(Charsets.UTF_8))
        val blob = ByteArray(1 + c.iv.size + ct.size)
        blob[0] = c.iv.size.toByte()
        System.arraycopy(c.iv, 0, blob, 1, c.iv.size)
        System.arraycopy(ct, 0, blob, 1 + c.iv.size, ct.size)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(id, Base64.encodeToString(blob, Base64.NO_WRAP)).apply()
    }

    fun get(ctx: Context, id: String): String? {
        val b64 = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(id, null) ?: return null
        return try {
            val blob = Base64.decode(b64, Base64.NO_WRAP)
            val ivLen = blob[0].toInt()
            val iv = blob.copyOfRange(1, 1 + ivLen)
            val ct = blob.copyOfRange(1 + ivLen, blob.size)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            String(c.doFinal(ct), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    fun remove(ctx: Context, id: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(id).apply()
    }
}
