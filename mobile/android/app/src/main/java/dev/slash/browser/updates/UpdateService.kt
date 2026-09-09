package dev.slash.browser.updates

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

data class UpdateInfo(
    val version: String,
    val fileUrl: String,
    val sha512: String,
    val size: Long,
    val notes: String
)

/**
 * Updates, from the same feed the desktop reads.
 *
 * Android inverts the desktop's blocker. Slash on Windows cannot auto-update
 * because it is unsigned and has no certificate; Android signing is a
 * self-signed keystore that costs nothing, so the phone *can* update itself.
 *
 * Two things follow from that, and both are in the code rather than in a plan:
 *
 *  - **The checksum is verified before anything is installed.** A download that
 *    matches its length and not its hash is not a slow network, it is a
 *    different file.
 *  - **The keystore is unrecoverable.** Every future build must be signed with
 *    the same key or `PackageInstaller` refuses it, and the only route back is
 *    uninstall-and-lose-your-data. That is a release-process fact, not a code
 *    one, which is exactly why it is written here where somebody will read it.
 *
 * `selectPackage` on the desktop reads `platforms['<platform>-<arch>']` and only
 * falls back to the flat fields for `win32-x64`. This asks for its own key and
 * nothing else: an Android build must never be handed the Windows `.exe`, which
 * would download, verify perfectly against its own checksum, and be unopenable.
 */
class UpdateService(private val context: Context) {

    var available by mutableStateOf<UpdateInfo?>(null)
        private set

    var status by mutableStateOf<String?>(null)
        private set

    var checking by mutableStateOf(false)
        private set

    /** The running version, so the UI can say what it is comparing against. */
    val currentVersion: String by lazy {
        runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty()
        }.getOrDefault("")
    }

    /**
     * The key this build looks for in the feed's `platforms` map.
     *
     * The shipped APK is universal — no native code — so one key covers every
     * device. If a future build ever splits by ABI this becomes
     * `android-${Build.SUPPORTED_ABIS[0]}` and the feed grows keys to match.
     */
    private val platformKey = "android-universal"

    suspend fun check(feedUrl: String): Result<UpdateInfo?> = withContext(Dispatchers.IO) {
        if (feedUrl.isBlank()) {
            return@withContext Result.failure(IllegalStateException("No update feed is set."))
        }
        checking = true
        try {
            val feed = JSONObject(get(feedUrl))
            val version = feed.optString("version")
            if (version.isEmpty()) {
                status = "The update feed did not name a version."
                return@withContext Result.success(null)
            }

            val platforms = feed.optJSONObject("platforms")
            val entry = platforms?.optJSONObject(platformKey)
            if (entry == null) {
                // Deliberately not falling back to the flat fields: those are
                // the Windows installer, for ever, so every Slash released
                // before Android existed keeps reading them.
                status = "This release has no Android package yet."
                return@withContext Result.success(null)
            }

            val info = UpdateInfo(
                version = version,
                fileUrl = entry.optString("fileUrl"),
                sha512 = entry.optString("sha512"),
                size = entry.optLong("size"),
                notes = feed.optString("notes")
            )
            if (info.fileUrl.isEmpty() || info.sha512.isEmpty()) {
                status = "The Android package is missing an address or a checksum."
                return@withContext Result.success(null)
            }

            if (!isNewer(info.version, currentVersion)) {
                available = null
                status = "Slash is up to date."
                return@withContext Result.success(null)
            }
            available = info
            status = "Version ${info.version} is available."
            Result.success(info)
        } catch (error: Exception) {
            status = error.message
            Log.w(TAG, "update check failed", error)
            Result.failure(error)
        } finally {
            checking = false
        }
    }

    /**
     * Downloads, verifies, and hands the package to the system installer.
     *
     * The user still confirms — Android shows its own install prompt, and there
     * is no way to skip it that does not involve being a system app. That is the
     * right shape anyway: a browser that could replace itself silently is a
     * browser that could be made to replace itself with something else.
     */
    suspend fun download(info: UpdateInfo): Result<File> = withContext(Dispatchers.IO) {
        try {
            status = "Downloading ${info.version}…"
            val target = File(context.cacheDir, "slash-${info.version}.apk")
            target.delete()

            val connection = (URL(info.fileUrl).openConnection() as HttpURLConnection).apply {
                connectTimeout = 20_000
                readTimeout = 60_000
            }
            try {
                if (connection.responseCode !in 200..299) {
                    throw IllegalStateException("Download returned ${connection.responseCode}")
                }
                connection.inputStream.use { input ->
                    target.outputStream().use { output -> input.copyTo(output) }
                }
            } finally {
                connection.disconnect()
            }

            status = "Checking the download…"
            val digest = sha512(target)
            if (!digest.equals(info.sha512.removePrefix("sha512:"), ignoreCase = true)) {
                target.delete()
                // Not a retry-worthy failure. A file that arrived complete and
                // hashes differently is a different file, and installing it is
                // the one thing that must not happen.
                throw IllegalStateException(
                    "The download did not match its checksum, so it was not installed."
                )
            }
            status = "Ready to install."
            Result.success(target)
        } catch (error: Exception) {
            status = error.message
            Log.w(TAG, "update download failed", error)
            Result.failure(error)
        }
    }

    /** Opens the system installer for a verified package. */
    fun install(apk: File): Result<Unit> = runCatching {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL
        )
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("slash", 0, apk.length()).use { output ->
                apk.inputStream().use { it.copyTo(output) }
                session.fsync(output)
            }
            val intent = Intent(context, UpdateReceiver::class.java)
            val flags = android.app.PendingIntent.FLAG_MUTABLE or
                android.app.PendingIntent.FLAG_UPDATE_CURRENT
            val pending = android.app.PendingIntent.getBroadcast(context, sessionId, intent, flags)
            session.commit(pending.intentSender)
        }
        status = "Waiting for Android to install it."
    }.onFailure {
        status = it.message
        Log.w(TAG, "install failed", it)
    }

    private fun get(url: String): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 20_000
        }
        return try {
            if (connection.responseCode !in 200..299) {
                throw IllegalStateException("Feed returned ${connection.responseCode}")
            }
            connection.inputStream.bufferedReader().use(BufferedReader::readText)
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        private const val TAG = "SlashUpdates"

        private fun sha512(file: File): String {
            val digest = MessageDigest.getInstance("SHA-512")
            file.inputStream().use { input ->
                val buffer = ByteArray(1 shl 16)
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    digest.update(buffer, 0, read)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }

        /**
         * Compares dotted versions numerically.
         *
         * String comparison would make "0.10.0" older than "0.9.0", which is the
         * bug that only shows up once a project reaches its tenth minor and then
         * silently stops offering updates.
         */
        fun isNewer(candidate: String, current: String): Boolean {
            if (current.isBlank()) return true
            val a = candidate.split('.').map { it.toIntOrNull() ?: 0 }
            val b = current.split('.').map { it.toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(a.size, b.size)) {
                val x = a.getOrElse(i) { 0 }
                val y = b.getOrElse(i) { 0 }
                if (x != y) return x > y
            }
            return false
        }
    }
}
