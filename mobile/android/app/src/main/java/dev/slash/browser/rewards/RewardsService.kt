package dev.slash.browser.rewards

import android.content.Context
import android.util.Base64
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dev.slash.browser.core.SlashCore
import dev.slash.browser.data.CoinStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

data class CoinState(
    val balance: Double = 0.0,
    val secondsToday: Long = 0,
    val coinsPerHour: Double = 0.0,
    val dailyCapSeconds: Long = 21_600,
    val coinToUsd: Double? = null
)

/**
 * Slash Coin.
 *
 * Speaks the same protocol as `src/main/rewards/RewardsService.ts` against the
 * same Supabase project, so a balance earned on the desktop and a balance earned
 * on the phone are one balance — the account is the join, not the device.
 *
 * Three properties are load-bearing and are the reason this is not a simple
 * timer:
 *
 *  - **The client never computes a balance.** It reports closed intervals and
 *    displays whatever the server returns. A balance the client owns is one a
 *    text editor can forge, and this is meant to become tradeable. The overlap
 *    rule lives in Postgres as a GiST exclusion constraint, so twenty devices
 *    signed into one account earn the time of one even if this code is wrong.
 *  - **The earning rules come from the shared core.** `earningAdvance` is the
 *    desktop's own `advance()`. A phone that has been asleep wakes with a clock
 *    hours further on, and a re-implementation that was *nearly* right would be
 *    indistinguishable from the real one until somebody noticed it banking the
 *    night.
 *  - **Intervals survive being offline.** They go to a SQLite outbox the moment
 *    they close and are removed only once the server has seen them — accepted or
 *    rejected, because a rejected interval is one it will never take and
 *    retrying it for ever would be a loop with no exit.
 */
class RewardsService(
    private val context: Context,
    private val coins: CoinStore,
    /** Supplies the shared core. Null until it has loaded. */
    private val core: () -> SlashCore?
) {
    var isSignedIn by mutableStateOf(false)
        private set

    var accountLabel by mutableStateOf("")
        private set

    var state by mutableStateOf(CoinState())
        private set

    var lastError by mutableStateOf<String?>(null)
        private set

    /** Unreported time, so the UI can show that nothing has been lost offline. */
    var pendingSeconds by mutableStateOf(0L)
        private set

    private var accessToken: String? = null
    private var refreshToken: String? = null
    private var expiresAt: Long = 0
    private var pendingVerifier: String? = null

    /** The open interval, as the shared core represents it. Null when not earning. */
    private var intervalState: JSONObject? = null

    private val prefs by lazy {
        // Tokens are the one secret this app holds. EncryptedSharedPreferences
        // keys them from the Android keystore, which is the platform equivalent
        // of the desktop's safeStorage — and, as there, no secure store means no
        // sign-in rather than a readable fallback.
        runCatching {
            EncryptedSharedPreferences.create(
                context,
                "slash_rewards",
                MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        }.getOrNull()
    }

    private val deviceId: String by lazy {
        prefs?.getString(KEY_DEVICE, null) ?: UUID.randomUUID().toString().also {
            prefs?.edit()?.putString(KEY_DEVICE, it)?.apply()
        }
    }

    init {
        restore()
    }

    private fun restore() {
        val store = prefs ?: return
        refreshToken = store.getString(KEY_REFRESH, null)
        accountLabel = store.getString(KEY_EMAIL, "").orEmpty()
        isSignedIn = refreshToken != null
    }

    private fun persist() {
        val store = prefs ?: return
        store.edit()
            .putString(KEY_REFRESH, refreshToken)
            .putString(KEY_EMAIL, accountLabel)
            .apply()
    }

    // --- the earning clock ------------------------------------------------------

    /**
     * One tick. Called from the activity's lifecycle, not a timer — "is Slash
     * visible" is something Android already knows.
     *
     * The decision of what counts is the shared core's, not this file's.
     */
    suspend fun sample(qualifying: Boolean, now: Long = System.currentTimeMillis()) {
        val bridge = core() ?: return
        val result = runCatching {
            bridge.callObject(
                "earningAdvance",
                JSONObject().apply {
                    intervalState?.let { put("state", it) }
                    put("sample", JSONObject().put("at", now).put("qualifying", qualifying))
                }
            )
        }.getOrNull() ?: return

        intervalState = result.optJSONObject("state")

        // The core bridge resolves on the main thread — it is a WebView — so
        // anything touching SQLite after it has to hop off, or the clock does
        // disk I/O on the UI thread every thirty seconds.
        val closed = result.optJSONObject("closed")
        if (closed != null || accountLabel.isNotBlank()) {
            withContext(Dispatchers.IO) {
                closed?.let(::bank)
                pendingSeconds = coins.pendingSeconds(accountLabel)
            }
        }
    }

    /** Visible → not visible. Whatever was open ends here. */
    suspend fun pause(now: Long = System.currentTimeMillis()) {
        sample(qualifying = false, now = now)
        report()
    }

    private fun bank(closed: JSONObject) {
        val seconds = closed.optLong("seconds")
        if (seconds <= 0 || accountLabel.isBlank()) return
        coins.add(
            account = accountLabel,
            startedAt = closed.optLong("startedAt"),
            endedAt = closed.optLong("endedAt"),
            seconds = seconds
        )
    }

    // --- sign-in ----------------------------------------------------------------

    /**
     * Returns the URL the shell should open **in a Slash tab**.
     *
     * PKCE, with no `state` parameter: the desktop measured that this provider
     * passes a supplied state straight through to Google and then cannot resolve
     * the flow keyed by it (`bad_oauth_state`). The binding here is the verifier,
     * which never leaves the process.
     */
    fun beginSignIn(): String? {
        if (prefs == null) {
            lastError = "This device has no secure store, so Slash will not sign in."
            return null
        }
        val verifier = randomUrlSafe(64)
        pendingVerifier = verifier
        val challenge = Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
        )
        return "$SUPABASE_URL/auth/v1/authorize?provider=google" +
            "&code_challenge=$challenge&code_challenge_method=S256"
    }

    /** True if this navigation carried the auth code and was consumed. */
    fun offerNavigation(url: String): Boolean {
        if (pendingVerifier == null) return false
        return extractCode(url) != null
    }

    /**
     * Completes a sign-in from a navigation carrying a code.
     *
     * Deliberately not tied to one redirect address: the provider falls back to
     * its own configured site address whenever it cannot resolve a flow, and on
     * the desktop that address answered nothing — which presented as a
     * connection error rather than an auth failure and cost several rounds.
     */
    suspend fun completeSignIn(url: String): Boolean = withContext(Dispatchers.IO) {
        val verifier = pendingVerifier ?: return@withContext false
        val code = extractCode(url) ?: return@withContext false
        pendingVerifier = null

        try {
            val body = post(
                "$SUPABASE_URL/auth/v1/token?grant_type=pkce",
                JSONObject().put("auth_code", code).put("code_verifier", verifier),
                authorised = false
            )
            val access = body.optString("access_token").ifEmpty { null }
            val refresh = body.optString("refresh_token").ifEmpty { null }
            if (access == null || refresh == null) {
                lastError = "Sign-in did not return a session."
                return@withContext false
            }
            accessToken = access
            refreshToken = refresh
            expiresAt = System.currentTimeMillis() + body.optLong("expires_in", 3600) * 1000
            accountLabel = body.optJSONObject("user")?.optString("email").orEmpty()
            isSignedIn = true
            persist()

            // Says which kind of account this is, so somebody collecting coin
            // does not appear in the advertiser list. Supabase's OAuth endpoint
            // carries no custom signup metadata, so it cannot be done at signup.
            runCatching { rpc("mark_browser_account", JSONObject()) }
            refreshState()
            lastError = null
            true
        } catch (error: Exception) {
            lastError = error.message
            Log.w(TAG, "sign-in failed", error)
            false
        }
    }

    fun signOut() {
        accessToken = null
        refreshToken = null
        accountLabel = ""
        isSignedIn = false
        state = CoinState()
        intervalState = null
        prefs?.edit()?.clear()?.apply()
    }

    // --- reporting --------------------------------------------------------------

    /** Sends whatever is in the outbox and refreshes the balance. */
    suspend fun report() = withContext(Dispatchers.IO) {
        if (!isSignedIn || accountLabel.isBlank()) return@withContext
        val rows = coins.pending(accountLabel)
        if (rows.isEmpty()) {
            runCatching { refreshState() }
            return@withContext
        }

        try {
            val entries = JSONArray()
            for (row in rows) {
                entries.put(
                    JSONObject()
                        .put("deviceId", deviceId)
                        .put("startedAt", iso(row.startedAt))
                        .put("endedAt", iso(row.endedAt))
                        .put("seconds", row.seconds)
                )
            }
            val result = rpc("record_coin_intervals", JSONObject().put("entries", entries))

            // Seen is seen. A rejected interval — an overlap, or something too
            // old — is one the server will never take, so keeping it would mean
            // resending it for ever.
            coins.remove(rows.map { it.id })
            pendingSeconds = coins.pendingSeconds(accountLabel)
            state = state.copy(balance = result.optDouble("balance", state.balance))
            refreshState()
            lastError = null
        } catch (error: Exception) {
            // Left in the outbox for the next attempt. Being offline is an
            // ordinary state on a phone, not an error worth interrupting anybody.
            Log.w(TAG, "could not report intervals", error)
            lastError = error.message
        }
    }

    suspend fun refreshState() = withContext(Dispatchers.IO) {
        if (!isSignedIn) return@withContext
        runCatching {
            val s = rpc("coin_state", JSONObject())
            state = CoinState(
                balance = s.optDouble("balance", 0.0),
                secondsToday = s.optLong("secondsToday"),
                coinsPerHour = s.optDouble("coinsPerHour", 0.0),
                dailyCapSeconds = s.optLong("dailyCapSeconds").takeIf { it > 0 } ?: 21_600,
                // Absent or null means unpublished, and that must survive as
                // null all the way to the screen rather than collapsing to zero.
                coinToUsd = if (s.isNull("coinToUsd")) null else s.optDouble("coinToUsd")
            )
            pendingSeconds = coins.pendingSeconds(accountLabel)
        }.onFailure { Log.w(TAG, "could not read coin state", it) }
    }

    // --- transport --------------------------------------------------------------

    private suspend fun freshAccessToken(): String {
        val current = accessToken
        if (current != null && System.currentTimeMillis() < expiresAt - 60_000) return current

        val refresh = refreshToken ?: return ""
        return try {
            val body = post(
                "$SUPABASE_URL/auth/v1/token?grant_type=refresh_token",
                JSONObject().put("refresh_token", refresh),
                authorised = false
            )
            val access = body.optString("access_token").ifEmpty { null } ?: return ""
            accessToken = access
            refreshToken = body.optString("refresh_token").ifEmpty { refresh }
            expiresAt = System.currentTimeMillis() + body.optLong("expires_in", 3600) * 1000
            persist()
            access
        } catch (error: Exception) {
            val gone = Regex(
                "refresh_token_not_found|invalid_grant|expired|already used",
                RegexOption.IGNORE_CASE
            ).containsMatchIn(error.message.orEmpty())
            // A refresh token the server has forgotten will never work again;
            // holding it means every later call fails the same way with no way
            // for the user to recover except reinstalling.
            if (gone) signOut()
            ""
        }
    }

    private suspend fun rpc(name: String, body: JSONObject): JSONObject =
        post("$SUPABASE_URL/rest/v1/rpc/$name", body, authorised = true)

    private suspend fun post(url: String, body: JSONObject, authorised: Boolean): JSONObject {
        val token = if (authorised) freshAccessToken() else ""
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 30_000
            setRequestProperty("apikey", SUPABASE_ANON_KEY)
            setRequestProperty("content-type", "application/json")
            if (authorised) {
                setRequestProperty(
                    "authorization",
                    "Bearer ${token.ifEmpty { SUPABASE_ANON_KEY }}"
                )
            }
        }
        return try {
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            if (code !in 200..299) throw IllegalStateException("$url returned $code: $text")
            if (text.isBlank()) JSONObject() else parse(text)
        } finally {
            connection.disconnect()
        }
    }

    /** PostgREST returns a bare value or a single-element array for some functions. */
    private fun parse(text: String): JSONObject = when {
        text.trimStart().startsWith("[") ->
            JSONArray(text).optJSONObject(0) ?: JSONObject()
        text.trimStart().startsWith("{") -> JSONObject(text)
        else -> JSONObject()
    }

    companion object {
        private const val TAG = "SlashRewards"
        private const val KEY_REFRESH = "refresh_token"
        private const val KEY_EMAIL = "email"
        private const val KEY_DEVICE = "device_id"

        /**
         * The same project the desktop uses, from `shared/types/rewards.ts` —
         * which is what makes one account's balance the same balance on both.
         *
         * The anon key is publishable by design: the ledger is protected by
         * row-level security and the crediting function is the only write path
         * in, both attacked by `supabase/coinProbe.py` against this exact
         * endpoint with a real signed token. A key that had to be secret could
         * not be in a browser at all.
         */
        const val SUPABASE_URL = "https://edsuuwzihojdsmgzhzyw.supabase.co"
        const val SUPABASE_ANON_KEY =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkc3V1d3ppaG9qZHNtZ3poenl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MTcyNDcsImV4cCI6MjEwMjk5MzI0N30.AmssiF7U8jlIUNpjBy4-V7Z6jKnEbQAgCv6PLrJItL0"

        private val random = SecureRandom()

        fun randomUrlSafe(bytes: Int): String =
            Base64.encodeToString(
                ByteArray(bytes).also(random::nextBytes),
                Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
            )

        /**
         * Pulls `code=` out of a URL's query or fragment.
         *
         * One function, used by both the navigation watcher and any paste
         * fallback, so the two cannot disagree about what a code looks like.
         */
        fun extractCode(url: String): String? =
            Regex("[?#&]code=([^&#]+)").find(url)?.groupValues?.get(1)?.takeIf { it.isNotBlank() }

        private fun iso(millis: Long): String =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
                .apply { timeZone = TimeZone.getTimeZone("UTC") }
                .format(Date(millis))
    }
}
