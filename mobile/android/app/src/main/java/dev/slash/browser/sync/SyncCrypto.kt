package dev.slash.browser.sync

import android.util.Base64
import org.bouncycastle.crypto.generators.SCrypt
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.crypto.Mac

/**
 * End-to-end encryption for synced data, matching `src/main/sync/crypto.ts`
 * **exactly**.
 *
 * Every constant here is load-bearing in a way most constants are not: this is
 * one half of a two-implementation protocol, and a mismatch does not throw a
 * useful error. A different scrypt N gives a different key, and the far end
 * simply reports "could not decrypt" for every item forever — which reads as a
 * wrong passphrase, so the user retypes a correct one repeatedly and concludes
 * sync is broken.
 *
 * The pairing is therefore asserted by `SyncCryptoTest` against vectors taken
 * from the desktop, not by having been read carefully.
 *
 * The passphrase **never leaves the device**, and no key derived from it is
 * stored. Forget it and the synced data is unrecoverable, because nobody holds
 * a spare — that is the cost of the server genuinely not being able to read it.
 */
object SyncCrypto {

    // Matching src/main/sync/crypto.ts. Do not change one of these alone.
    private const val SCRYPT_N = 16384
    private const val SCRYPT_R = 8
    private const val SCRYPT_P = 1
    private const val KEY_BYTES = 32
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
    private const val TAG_BYTES = TAG_BITS / 8
    const val SALT_BYTES = 16

    private val random = SecureRandom()

    data class SyncKey(val key: ByteArray, val saltHex: String) {
        // ByteArray in a data class gives reference equality on equals/hashCode,
        // which is wrong and silently so. Overridden rather than left to surprise.
        override fun equals(other: Any?): Boolean =
            other is SyncKey && key.contentEquals(other.key) && saltHex == other.saltHex

        override fun hashCode(): Int = 31 * key.contentHashCode() + saltHex.hashCode()
    }

    /**
     * Derives the encryption key from a passphrase.
     *
     * NFKC-normalised first, because the same passphrase typed on Android and on
     * Windows can be different byte sequences otherwise — composed vs decomposed
     * accents — and would derive two different keys from what the user typed as
     * one password.
     */
    fun deriveKey(passphrase: String, saltHex: String? = null): SyncKey {
        val salt = saltHex?.let(::hexToBytes) ?: ByteArray(SALT_BYTES).also(random::nextBytes)
        require(salt.size == SALT_BYTES) { "sync salt is the wrong length" }
        val normalised = Normalizer.normalize(passphrase, Normalizer.Form.NFKC)
        val key = SCrypt.generate(
            normalised.toByteArray(Charsets.UTF_8),
            salt,
            SCRYPT_N,
            SCRYPT_R,
            SCRYPT_P,
            KEY_BYTES
        )
        return SyncKey(key, bytesToHex(salt))
    }

    /**
     * Encrypts one item as base64(iv | tag | ciphertext).
     *
     * A fresh random IV every time. Reusing one under GCM is catastrophic — it
     * leaks the XOR of two plaintexts and the authentication key with it — so it
     * is generated here rather than being a parameter a caller could pass twice.
     *
     * Note the layout: Java's GCM cipher appends the tag to the ciphertext,
     * while the desktop writes it *before*. The reorder below is the whole
     * reason this is not a two-line function.
     */
    fun encrypt(key: ByteArray, plaintext: String): String {
        val iv = ByteArray(IV_BYTES).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        val sealed = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))

        // sealed = ciphertext | tag  ->  out = iv | tag | ciphertext
        val bodyLength = sealed.size - TAG_BYTES
        val out = ByteArray(IV_BYTES + sealed.size)
        System.arraycopy(iv, 0, out, 0, IV_BYTES)
        System.arraycopy(sealed, bodyLength, out, IV_BYTES, TAG_BYTES)
        System.arraycopy(sealed, 0, out, IV_BYTES + TAG_BYTES, bodyLength)
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    /**
     * Decrypts one item, or returns null.
     *
     * **Null rather than a throw**, matching the desktop: one corrupt or foreign
     * item must not stop a sync. Refusing all of a user's data because a single
     * row was written under a different passphrase is a worse outcome than
     * skipping that row.
     */
    fun decrypt(key: ByteArray, encoded: String): String? = try {
        val raw = Base64.decode(encoded, Base64.DEFAULT)
        if (raw.size < IV_BYTES + TAG_BYTES) {
            null
        } else {
            val iv = raw.copyOfRange(0, IV_BYTES)
            val tag = raw.copyOfRange(IV_BYTES, IV_BYTES + TAG_BYTES)
            val body = raw.copyOfRange(IV_BYTES + TAG_BYTES, raw.size)

            // Back to Java's order: ciphertext | tag.
            val sealed = ByteArray(body.size + TAG_BYTES)
            System.arraycopy(body, 0, sealed, 0, body.size)
            System.arraycopy(tag, 0, sealed, body.size, TAG_BYTES)

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(sealed), Charsets.UTF_8)
        }
    } catch (_: Exception) {
        // Wrong key, tampered ciphertext, or truncated data. All three are
        // "cannot read this one", and none should be distinguishable from
        // outside.
        null
    }

    /**
     * A short check value proving two devices share a passphrase.
     *
     * Uploaded once so a second device can tell "wrong passphrase" from "no data
     * yet" — otherwise a typo looks exactly like a fresh account and the user
     * starts a second, permanently diverged history.
     *
     * It is the GCM auth tag over a fixed label with a fixed all-`0x07` IV. A
     * fixed IV would be a serious bug anywhere else; here nothing secret is
     * encrypted under it, and the tag has to be reproducible across devices to
     * be a verifier at all.
     */
    fun verifier(key: ByteArray): String {
        val iv = ByteArray(IV_BYTES) { 7 }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        val sealed = cipher.doFinal("slash-sync-verifier".toByteArray(Charsets.UTF_8))
        return bytesToHex(sealed.copyOfRange(sealed.size - TAG_BYTES, sealed.size))
    }

    /** Constant-time, so a wrong passphrase cannot be narrowed by timing. */
    fun verifierMatches(key: ByteArray, expected: String): Boolean {
        val ours = hexToBytes(verifier(key))
        val theirs = try {
            hexToBytes(expected)
        } catch (_: Exception) {
            return false
        }
        return MessageDigest.isEqual(ours, theirs)
    }

    /**
     * The opaque id a history entry travels under — HMAC-SHA256 under the sync
     * key, matching `historySync.ts`.
     *
     * Not the URL, and not a plain hash of it: URLs are public and low-entropy,
     * so `sha256(url)` is reversible with one precomputed table and would hand
     * the server everybody's history in effect.
     */
    fun historyItemId(key: ByteArray, url: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return bytesToHex(mac.doFinal(url.toByteArray(Charsets.UTF_8)))
    }

    fun bytesToHex(bytes: ByteArray): String =
        buildString(bytes.size * 2) { for (b in bytes) append("%02x".format(b)) }

    fun hexToBytes(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "hex string has an odd length" }
        return ByteArray(hex.length / 2) {
            hex.substring(it * 2, it * 2 + 2).toInt(16).toByte()
        }
    }
}
