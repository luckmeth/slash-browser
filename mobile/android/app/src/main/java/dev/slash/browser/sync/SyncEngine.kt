package dev.slash.browser.sync

import android.util.Log
import dev.slash.browser.data.Bookmark
import dev.slash.browser.data.BookmarkStore
import dev.slash.browser.data.HistoryStore
import dev.slash.browser.settings.SettingsStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.TimeUnit

/** One row of the protocol. Mirrors `SyncItem` in `merge.ts`. */
data class SyncItem(
    val id: String,
    val collection: String,
    val updatedAt: Long,
    val deleted: Boolean,
    val payload: String
)

data class SyncStatus(
    val enabled: Boolean,
    val unlocked: Boolean,
    val lastSyncAt: Long?,
    val lastError: String?,
    val itemCount: Int
)

/**
 * The Android half of sync.
 *
 * Speaks the protocol in `docs/sync.md` — a GET with a cursor and a POST of
 * changed items — so any server the desktop works against works here, and the
 * two platforms merge into the same account.
 *
 * The passphrase is held **in memory only**, for as long as the process lives.
 * It is never written to disk, never put in SharedPreferences, and never sent
 * anywhere: the endpoint receives ciphertext and a timestamp. That is the whole
 * reason the user has to type it once per device, and the settings copy says so
 * rather than letting them discover it.
 */
class SyncEngine(
    private val settings: SettingsStore,
    private val history: HistoryStore,
    private val bookmarks: BookmarkStore,
    private val deviceId: String = UUID.randomUUID().toString()
) {
    private var key: ByteArray? = null
    private var saltHex: String? = null
    private var cursor: Long = 0
    private var lastSyncAt: Long? = null
    private var lastError: String? = null

    val isUnlocked: Boolean get() = key != null

    fun status(): SyncStatus = SyncStatus(
        enabled = settings.current.syncEnabled && settings.current.syncEndpoint.isNotBlank(),
        unlocked = isUnlocked,
        lastSyncAt = lastSyncAt,
        lastError = lastError,
        itemCount = if (settings.current.syncHistory) history.count() else 0
    )

    /** Forgets the key. Called on lock, and on any settings change that invalidates it. */
    fun lock() {
        key?.fill(0)
        key = null
        saltHex = null
    }

    /**
     * Derives the key from a passphrase and, if the server already holds a salt,
     * checks it against the stored verifier.
     *
     * The verifier is what lets a typo be distinguished from an empty account.
     * Without it a wrong passphrase looks exactly like a fresh start, and the
     * user cheerfully begins a second history that will never merge with the
     * first.
     */
    suspend fun unlock(passphrase: String): Result<Unit> = withContext(Dispatchers.IO) {
        if (passphrase.length < 8) {
            return@withContext Result.failure(IllegalArgumentException("Passphrase is too short."))
        }
        val endpoint = settings.current.syncEndpoint.trim()
        if (endpoint.isEmpty()) {
            return@withContext Result.failure(IllegalStateException("No sync endpoint is set."))
        }

        try {
            val head = fetch(endpoint, since = 0)
            val serverSalt = head.optString("salt").ifEmpty { null }
            val serverVerifier = head.optString("verifier").ifEmpty { null }

            val derived = SyncCrypto.deriveKey(passphrase, serverSalt)
            if (serverVerifier != null && !SyncCrypto.verifierMatches(derived.key, serverVerifier)) {
                return@withContext Result.failure(
                    IllegalArgumentException(
                        "That passphrase does not match the one this account was set up with."
                    )
                )
            }
            key = derived.key
            saltHex = derived.saltHex
            lastError = null
            Result.success(Unit)
        } catch (error: Exception) {
            Result.failure(error)
        }
    }

    /**
     * One sync pass: pull what is new, merge, push what this device changed.
     *
     * Failures are recorded and returned rather than thrown. A sync that cannot
     * reach the network is an ordinary state on a phone, not an error worth
     * interrupting anybody over.
     */
    suspend fun syncNow(): Result<SyncStatus> = withContext(Dispatchers.IO) {
        val currentKey = key
            ?: return@withContext Result.failure(IllegalStateException("Sync is locked."))
        val endpoint = settings.current.syncEndpoint.trim()
        if (endpoint.isEmpty() || !settings.current.syncEnabled) {
            return@withContext Result.failure(IllegalStateException("Sync is off."))
        }

        try {
            val remote = fetch(endpoint, cursor)
            val remoteItems = parseItems(remote.optJSONArray("items"))
            applyRemote(currentKey, remoteItems)

            val local = localItems(currentKey)
            // Everything local is offered; the server keeps whichever updatedAt
            // is greater. Simpler than tracking dirty rows, and correct — the
            // cost is bandwidth, which the retention window already bounds.
            push(endpoint, local)

            cursor = remote.optLong("cursor", cursor)
            lastSyncAt = System.currentTimeMillis()
            lastError = null
            Result.success(status())
        } catch (error: Exception) {
            lastError = error.message ?: "Sync failed."
            Log.w(TAG, "sync failed", error)
            Result.failure(error)
        }
    }

    // --- protocol -------------------------------------------------------------

    private fun fetch(endpoint: String, since: Long): JSONObject {
        val url = URL("$endpoint?since=$since&device=$deviceId")
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = TimeUnit.SECONDS.toMillis(15).toInt()
            readTimeout = TimeUnit.SECONDS.toMillis(30).toInt()
            authorise(this)
        }
        return connection.readJson()
    }

    private fun push(endpoint: String, items: List<SyncItem>) {
        if (items.isEmpty()) return
        val body = JSONObject().apply {
            put("device", deviceId)
            saltHex?.let { put("salt", it) }
            key?.let { put("verifier", SyncCrypto.verifier(it)) }
            put("items", JSONArray().apply {
                for (item in items) {
                    put(JSONObject().apply {
                        put("id", item.id)
                        put("collection", item.collection)
                        put("updatedAt", item.updatedAt)
                        put("deleted", item.deleted)
                        put("payload", item.payload)
                    })
                }
            })
        }

        val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            connectTimeout = TimeUnit.SECONDS.toMillis(15).toInt()
            readTimeout = TimeUnit.SECONDS.toMillis(30).toInt()
            authorise(this)
        }
        connection.outputStream.use { it.write(body.toString().toByteArray()) }
        connection.readJson()
    }

    private fun authorise(connection: HttpURLConnection) {
        val token = settings.current.syncToken.trim()
        if (token.isNotEmpty()) connection.setRequestProperty("Authorization", "Bearer $token")
    }

    /**
     * `HttpURLConnection` is not `Closeable`, so this cannot be a `use` block —
     * the connection is released in a `finally` instead. Forgetting that leaks a
     * socket per sync, which on a 30-minute timer takes a long time to notice.
     */
    private fun HttpURLConnection.readJson(): JSONObject = try {
        val code = responseCode
        val stream = if (code in 200..299) inputStream else errorStream
        val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
        if (code !in 200..299) throw IllegalStateException("Server returned $code")
        if (text.isBlank()) JSONObject() else JSONObject(text)
    } finally {
        disconnect()
    }

    private fun parseItems(array: JSONArray?): List<SyncItem> {
        if (array == null) return emptyList()
        return buildList {
            for (i in 0 until array.length()) {
                val o = array.optJSONObject(i) ?: continue
                val id = o.optString("id")
                val collection = o.optString("collection")
                // Anything not matching the shape is skipped wholesale rather
                // than partially applied — a malformed row must not become a
                // half-written bookmark.
                if (id.isEmpty() || collection.isEmpty()) continue
                add(
                    SyncItem(
                        id = id,
                        collection = collection,
                        updatedAt = o.optLong("updatedAt"),
                        deleted = o.optBoolean("deleted"),
                        payload = o.optString("payload")
                    )
                )
            }
        }
    }

    // --- projecting the database into sync items --------------------------------

    private fun localItems(key: ByteArray): List<SyncItem> = buildList {
        for (bookmark in bookmarks.all()) {
            add(
                SyncItem(
                    id = bookmark.guid,
                    collection = "bookmarks",
                    updatedAt = bookmark.updatedAt,
                    deleted = false,
                    payload = SyncCrypto.encrypt(
                        key,
                        JSONObject().apply {
                            put("url", bookmark.url)
                            put("title", bookmark.title)
                            put("faviconUrl", bookmark.faviconUrl)
                            put("isFolder", bookmark.isFolder)
                            put("sortOrder", bookmark.sortOrder)
                            put("parentGuid", bookmark.parentGuid)
                        }.toString()
                    )
                )
            )
        }

        if (settings.current.syncHistory) {
            val now = System.currentTimeMillis()
            val cutoff = now - RETENTION_DAYS * 24L * 60 * 60 * 1000
            history.forSync()
                .asSequence()
                .filter { it.lastVisitedAt >= cutoff }
                .sortedByDescending { it.lastVisitedAt }
                .take(MAX_HISTORY_ITEMS)
                .forEach { entry ->
                    add(
                        SyncItem(
                            // HMAC under the sync key, never the URL. A history
                            // collection keyed by plaintext URLs would hand the
                            // server the one thing this browser promises not to
                            // send.
                            id = SyncCrypto.historyItemId(key, entry.url),
                            collection = "history",
                            updatedAt = entry.lastVisitedAt,
                            deleted = false,
                            payload = SyncCrypto.encrypt(
                                key,
                                JSONObject().apply {
                                    put("url", entry.url)
                                    put("title", entry.title)
                                    put("faviconUrl", entry.faviconUrl)
                                    put("lastVisitedAt", entry.lastVisitedAt)
                                }.toString()
                            )
                        )
                    )
                }
        }

        for ((collection, itemId, deletedAt) in bookmarks.tombstones()) {
            add(SyncItem(itemId, collection, deletedAt, deleted = true, payload = ""))
        }
    }

    private fun applyRemote(key: ByteArray, items: List<SyncItem>) {
        for (item in items) {
            if (item.deleted) {
                if (item.collection == "bookmarks") bookmarks.remove(item.id)
                continue
            }
            val json = SyncCrypto.decrypt(key, item.payload)
            if (json == null) {
                // Written under a different passphrase, or damaged. Skipped
                // rather than failing the whole sync — the rest is fine.
                Log.w(TAG, "could not decrypt ${item.collection}/${item.id}; skipped")
                continue
            }
            runCatching {
                val data = JSONObject(json)
                when (item.collection) {
                    "bookmarks" -> applyBookmark(item, data)
                    "history" -> applyHistory(data)
                }
            }.onFailure { Log.w(TAG, "could not apply ${item.collection}/${item.id}", it) }
        }
    }

    private fun applyBookmark(item: SyncItem, data: JSONObject) {
        bookmarks.applyRemote(
            Bookmark(
                guid = item.id,
                url = data.optString("url").ifEmpty { null },
                title = data.optString("title"),
                faviconUrl = data.optString("faviconUrl").ifEmpty { null },
                parentGuid = data.optString("parentGuid").ifEmpty { null },
                isFolder = data.optBoolean("isFolder"),
                sortOrder = data.optInt("sortOrder"),
                updatedAt = item.updatedAt
            )
        )
    }

    /**
     * Keyed on the URL from the **decrypted payload**, not on `item.id` — the id
     * is an HMAC and cannot be turned back into a URL, which is the point of it.
     *
     * Takes the later visit and never touches the visit count: summing counts
     * across devices inflates them on every sync, fastest for the pages visited
     * most.
     */
    private fun applyHistory(data: JSONObject) {
        val url = data.optString("url")
        val visitedAt = data.optLong("lastVisitedAt")
        if (url.isEmpty() || visitedAt <= 0) return

        val local = history.find(url)
        if (local != null && local.lastVisitedAt >= visitedAt) return

        val remoteTitle = data.optString("title")
        history.applyRemote(
            url = url,
            title = if (remoteTitle.isNotBlank()) remoteTitle else local?.title.orEmpty(),
            faviconUrl = data.optString("faviconUrl").ifEmpty { null } ?: local?.faviconUrl,
            visitedAt = visitedAt
        )
    }

    private companion object {
        const val TAG = "SlashSync"
        const val RETENTION_DAYS = 90
        const val MAX_HISTORY_ITEMS = 5_000
    }
}
