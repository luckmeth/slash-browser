package dev.slash.browser.sponsor

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.slash.browser.settings.SettingsStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

data class SponsoredTile(
    val id: String,
    val sponsor: String,
    val headline: String,
    val body: String,
    /** A `data:` URL. Never a remote address — see `accept` below. */
    val image: String,
    val clickUrl: String,
    val placement: String,
    val startsAt: Long,
    val endsAt: Long
) {
    /**
     * The shape `sponsorRules.acceptCreative` expects.
     *
     * One place that knows the wire format is snake_case and the shared rules
     * are camelCase, so the translation cannot be forgotten at a second call
     * site the way it was at the first.
     */
    fun asCreative(): JSONObject = JSONObject()
        .put("id", id)
        .put("image", image)
        .put("clickUrl", clickUrl)
        .put("startsAt", if (startsAt > 0) startsAt else JSONObject.NULL)
        .put("endsAt", if (endsAt in 1 until Long.MAX_VALUE) endsAt else JSONObject.NULL)

    /**
     * Decoded once and kept, because a start page that re-decodes a base64
     * image on every recomposition is doing real work to draw the same pixels.
     */
    val bitmap: Bitmap? by lazy {
        runCatching {
            val comma = image.indexOf(',')
            if (comma < 0) return@runCatching null
            val bytes = Base64.decode(image.substring(comma + 1), Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()
    }
}

/**
 * Sponsored tiles on the start page.
 *
 * The privacy shape is the desktop's, and it is the whole design:
 *
 *  - **Batched, never per-impression.** Creatives are fetched ahead of time and
 *    chosen on-device. The fetch carries no identifier, no browsing data and
 *    nothing about which tile was shown.
 *  - **Images are inlined `data:` URLs.** A remote `<img src>` would be a
 *    request to the sponsor's server every time the tile appeared — a tracking
 *    pixel in a different hat, and it would defeat batching entirely.
 *  - **Inert without an endpoint.** With `sponsorEndpoint` empty, no request is
 *    ever made, so a fresh install contacts nothing.
 *
 * `acceptCreative` is not re-implemented here: it comes from the shared core, so
 * the two platforms cannot drift on a rule that is a privacy promise rather than
 * a formatting preference.
 */
class SponsorService(
    private val context: android.content.Context,
    private val settings: SettingsStore,
    private val acceptCreative: suspend (JSONObject) -> Boolean
) {
    var tiles by mutableStateOf<List<SponsoredTile>>(emptyList())
        private set

    var lastError by mutableStateOf<String?>(null)
        private set

    private var lastFetchAt = 0L
    private var rotation = 0

    /**
     * Counts, aggregated per tile per day, in memory and on disk.
     *
     * **Aggregated, never per-event.** A request at the moment of each
     * impression would tell the sponsor when a specific person looked at their
     * advert, which is precisely the tracking this design exists to avoid. A
     * daily total for a tile says how many times it was shown and nothing about
     * who or when.
     */
    private val counts = linkedMapOf<Pair<String, String>, IntArray>()

    private val cacheFile by lazy { java.io.File(context.filesDir, "sponsors.json") }

    private val endpoint: String get() = settings.current.sponsorEndpoint.trim()

    /**
     * Only the endpoint decides.
     *
     * There is no off switch: sponsored placements are what funds Slash, and a
     * setting that turns off the revenue is not a setting, it is an uninstall
     * with extra steps. What remains configurable is the *endpoint*, so a build
     * with none configured still contacts nothing — which is what keeps a fresh
     * install silent rather than what lets somebody opt out.
     */
    val isActive: Boolean get() = endpoint.isNotEmpty()

    /** The tile to show now, or null. Rotates so one sponsor does not own the slot. */
    fun tileFor(placement: String, now: Long = System.currentTimeMillis()): SponsoredTile? {
        val live = tiles.filter { it.placement == placement && now >= it.startsAt && now < it.endsAt }
        if (live.isEmpty()) return null
        return live[(rotation % live.size + live.size) % live.size]
    }

    fun rotate() {
        rotation += 1
    }

    /**
     * Records that a tile was shown.
     *
     * Idempotent per composition would be wrong — a tile genuinely shown twice
     * is two impressions — but this is called from the start page, which
     * recomposes for unrelated reasons, so the caller passes a key that changes
     * only when the tile actually appears.
     */
    fun noteImpression(tileId: String, now: Long = System.currentTimeMillis()) {
        bump(tileId, now, impressions = 1, clicks = 0)
    }

    fun noteClick(tileId: String, now: Long = System.currentTimeMillis()) {
        bump(tileId, now, impressions = 0, clicks = 1)
    }

    private fun bump(tileId: String, now: Long, impressions: Int, clicks: Int) {
        val day = dayOf(now)
        val row = counts.getOrPut(tileId to day) { intArrayOf(0, 0) }
        row[0] += impressions
        row[1] += clicks
    }

    private fun dayOf(millis: Long): String =
        java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
            .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
            .format(java.util.Date(millis))

    /**
     * Sends the aggregated counts.
     *
     * Kept on failure rather than dropped: an advertiser being under-reported
     * because a phone was on a train is somebody's money. Cleared only once the
     * server has accepted them.
     */
    suspend fun reportCounts() = withContext(Dispatchers.IO) {
        if (counts.isEmpty()) return@withContext
        val base = endpoint
        if (base.isEmpty()) return@withContext
        val reportUrl = runCatching { URL(URL(base), "report").toString() }.getOrNull()
            ?: return@withContext

        val payload = JSONObject().put(
            "counts",
            JSONArray().apply {
                for ((key, row) in counts) {
                    put(
                        JSONObject()
                            .put("tileId", key.first)
                            .put("day", key.second)
                            .put("impressions", row[0])
                            .put("clicks", row[1])
                    )
                }
            }
        )

        try {
            val connection = (URL(reportUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                useCaches = false
                connectTimeout = 15_000
                readTimeout = 20_000
                setRequestProperty("content-type", "application/json")
            }
            try {
                connection.outputStream.use { it.write(payload.toString().toByteArray()) }
                val code = connection.responseCode
                if (code !in 200..299) {
                    Log.w(TAG, "report rejected with $code; counts kept for next time")
                    return@withContext
                }
            } finally {
                connection.disconnect()
            }
            counts.clear()
        } catch (error: Exception) {
            Log.w(TAG, "could not report sponsor counts", error)
        }
    }

    /**
     * Fetches a batch, at most every [MIN_INTERVAL_MS].
     *
     * Silent on failure by design: an unreachable sponsor endpoint is not the
     * user's problem and must not become a visible error on the page they open
     * most. The start page simply shows nothing where a tile would be.
     */
    suspend fun refresh(force: Boolean = false) = withContext(Dispatchers.IO) {
        if (!isActive) {
            tiles = emptyList()
            return@withContext
        }
        val now = System.currentTimeMillis()
        if (!force && now - lastFetchAt < MIN_INTERVAL_MS) return@withContext
        lastFetchAt = now

        try {
            val body = get(endpoint)
            val array = body.optJSONArray("creatives")
                ?: body.optJSONArray("items")
                ?: JSONArray()

            val accepted = mutableListOf<SponsoredTile>()
            for (i in 0 until array.length()) {
                val row = array.optJSONObject(i) ?: continue
                val tile = parse(row) ?: continue
                // Asked of the shared core rather than decided here — but in
                // the shape the shared rules expect. `Creative` is camelCase
                // (`clickUrl`, `startsAt`); the wire format is snake_case, and
                // passing the raw row meant `clickUrl` was undefined, so the
                // https test refused *every* creative including the valid ones.
                if (!acceptCreative(tile.asCreative())) {
                    Log.w(TAG, "creative ${tile.id} refused by the shared rules")
                    continue
                }
                accepted += tile
            }
            tiles = accepted
            writeCache(accepted)
            lastError = null
            Log.i(TAG, "sponsor batch: ${accepted.size} accepted of ${array.length()}")
        } catch (error: Exception) {
            lastError = error.message
            Log.w(TAG, "sponsor fetch failed", error)
        }
    }

    /**
     * Reads the last batch from disk.
     *
     * A batch is bought by the hour and fetched at most every six, so holding it
     * only in memory meant every cold start either showed nothing or made a
     * fetch — the first cheats the advertiser out of hours they paid for, the
     * second turns "batched every six hours" into "on every launch".
     *
     * Creatives are **re-vetted on load**, not trusted because they were vetted
     * once: the file is on disk, and a rule that only runs at fetch time is a
     * rule that can be walked around by editing it.
     */
    suspend fun loadCache() = withContext(Dispatchers.IO) {
        if (!isActive) return@withContext
        val text = runCatching { cacheFile.takeIf { it.exists() }?.readText() }.getOrNull()
            ?: return@withContext
        runCatching {
            val stored = JSONObject(text)
            lastFetchAt = stored.optLong("fetchedAt")
            val array = stored.optJSONArray("creatives") ?: JSONArray()
            val restored = mutableListOf<SponsoredTile>()
            for (i in 0 until array.length()) {
                val row = array.optJSONObject(i) ?: continue
                val tile = parse(row) ?: continue
                if (!acceptCreative(tile.asCreative())) continue
                restored += tile
            }
            tiles = restored
        }.onFailure { Log.w(TAG, "could not read the sponsor cache", it) }
    }

    private fun writeCache(accepted: List<SponsoredTile>) {
        runCatching {
            val array = JSONArray()
            for (tile in accepted) {
                array.put(
                    JSONObject()
                        .put("id", tile.id)
                        .put("sponsor", tile.sponsor)
                        .put("headline", tile.headline)
                        .put("body", tile.body)
                        .put("image", tile.image)
                        .put("click_url", tile.clickUrl)
                        .put("placement", tile.placement)
                        .put("starts_at", tile.startsAt)
                        .put("ends_at", tile.endsAt)
                )
            }
            cacheFile.writeText(
                JSONObject().put("fetchedAt", lastFetchAt).put("creatives", array).toString()
            )
        }.onFailure { Log.w(TAG, "could not write the sponsor cache", it) }
    }

    /** Everything this feature holds, for a "forget it all" action. */
    fun clear() {
        tiles = emptyList()
        counts.clear()
        lastFetchAt = 0
        runCatching { cacheFile.delete() }
    }

    private fun parse(row: JSONObject): SponsoredTile? {
        val id = row.optString("id").ifEmpty { return null }
        return SponsoredTile(
            id = id,
            sponsor = row.optString("sponsor"),
            headline = row.optString("headline"),
            body = row.optString("body"),
            image = row.optString("image"),
            clickUrl = row.optString("click_url").ifEmpty { row.optString("clickUrl") },
            placement = row.optString("placement").ifEmpty { "tile" },
            startsAt = row.optLong("starts_at", row.optLong("startsAt")),
            endsAt = row.optLong("ends_at", row.optLong("endsAt", Long.MAX_VALUE))
        )
    }

    private fun get(url: String): JSONObject {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15_000
            readTimeout = 20_000
        }
        return try {
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            if (code !in 200..299) throw IllegalStateException("sponsor endpoint returned $code")
            if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val TAG = "SlashSponsor"

        /** Refetch no more often than this, however many times the page is opened. */
        const val MIN_INTERVAL_MS = 6 * 60 * 60 * 1000L
    }
}
