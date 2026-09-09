package dev.slash.browser.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.util.UUID

/**
 * Local storage. SQLite is the source of truth here exactly as it is on desktop.
 *
 * Framework SQLite rather than Room: Room's value is compile-time-checked DAOs,
 * and buying that costs a KSP plugin and an annotation processor in a build that
 * currently has neither. The schema below is small, fixed, and has to mirror the
 * desktop's tables anyway — so the queries are written once and read against
 * `src/main/db/migrations/index.ts`.
 *
 * Column names match the desktop deliberately. They are not a public interface,
 * but two people reading the same feature on two platforms should not have to
 * translate `last_visited_at` into `lastVisited` on the way.
 */
class SlashDatabase(context: Context) : SQLiteOpenHelper(context, NAME, null, VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE history_visits (
              id              INTEGER PRIMARY KEY AUTOINCREMENT,
              url             TEXT    NOT NULL UNIQUE,
              title           TEXT    NOT NULL DEFAULT '',
              favicon_url     TEXT,
              visit_count     INTEGER NOT NULL DEFAULT 1,
              last_visited_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        // The default listing is ORDER BY last_visited_at DESC; DESC in the
        // index lets SQLite walk it directly instead of sorting.
        db.execSQL("CREATE INDEX idx_history_last_visited ON history_visits (last_visited_at DESC)")

        db.execSQL(
            """
            CREATE TABLE bookmarks (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              guid        TEXT    NOT NULL UNIQUE,
              url         TEXT,
              title       TEXT    NOT NULL DEFAULT '',
              favicon_url TEXT,
              parent_guid TEXT,
              is_folder   INTEGER NOT NULL DEFAULT 0,
              sort_order  INTEGER NOT NULL DEFAULT 0,
              created_at  INTEGER NOT NULL,
              updated_at  INTEGER NOT NULL
            )
            """.trimIndent()
        )

        // The coin outbox. Intervals are written here the moment they close and
        // removed only once the server has *seen* them — accepted or rejected,
        // because a rejected interval is one it will never take (an overlap, or
        // something too old) and retrying it for ever would be a loop with no
        // exit. Without this table an interval closed while offline is simply
        // lost, which is somebody's earned time.
        db.execSQL(COIN_INTERVALS)
        db.execSQL(COIN_INTERVALS_INDEX)

        // A deletion that has to reach another device is a row, not an absence.
        // Without this, "missing here" is indistinguishable from "new there" and
        // every deleted item returns on the next sync.
        db.execSQL(
            """
            CREATE TABLE sync_tombstones (
              collection TEXT    NOT NULL,
              item_id    TEXT    NOT NULL,
              deleted_at INTEGER NOT NULL,
              PRIMARY KEY (collection, item_id)
            )
            """.trimIndent()
        )
    }

    /**
     * Numbered steps, never a drop-and-recreate — that would take the user's
     * history and bookmarks with it.
     *
     * v2 added `coin_intervals`. It was first written into `onCreate` alone,
     * which meant it existed on a fresh install and *not* on any device that
     * already had the database — so the app crashed with "no such table" the
     * moment the earning clock ticked. A new table needs both: the CREATE here
     * and the one above.
     */
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL(COIN_INTERVALS)
            db.execSQL(COIN_INTERVALS_INDEX)
        }
    }

    companion object {
        private const val NAME = "slash.db"

        /** 2: added `coin_intervals`. Bump this with every schema change. */
        private const val VERSION = 2

        /** Held once so `onCreate` and `onUpgrade` cannot describe it differently. */
        private val COIN_INTERVALS = """
            CREATE TABLE IF NOT EXISTS coin_intervals (
              id         INTEGER PRIMARY KEY AUTOINCREMENT,
              account    TEXT    NOT NULL,
              started_at INTEGER NOT NULL,
              ended_at   INTEGER NOT NULL,
              seconds    INTEGER NOT NULL
            )
        """.trimIndent()

        private const val COIN_INTERVALS_INDEX =
            "CREATE INDEX IF NOT EXISTS idx_coin_intervals_account ON coin_intervals (account, started_at)"
    }
}

data class HistoryEntry(
    val url: String,
    val title: String,
    val faviconUrl: String?,
    val visitCount: Int,
    val lastVisitedAt: Long
)

data class Bookmark(
    val guid: String,
    val url: String?,
    val title: String,
    val faviconUrl: String?,
    val parentGuid: String?,
    val isFolder: Boolean,
    val sortOrder: Int,
    val updatedAt: Long
)

/**
 * History reads and writes.
 *
 * Recording a visit is on the browsing path — it runs on every page load — so it
 * is one upsert with no read first, and the caller never waits on it.
 */
class HistoryStore(private val helper: SlashDatabase) {

    fun record(url: String, title: String, faviconUrl: String?, now: Long = System.currentTimeMillis()) {
        if (!url.startsWith("http")) return
        helper.writableDatabase.execSQL(
            """
            INSERT INTO history_visits (url, title, favicon_url, visit_count, last_visited_at)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(url) DO UPDATE SET
              title = CASE WHEN excluded.title != '' THEN excluded.title ELSE history_visits.title END,
              favicon_url = COALESCE(excluded.favicon_url, history_visits.favicon_url),
              visit_count = history_visits.visit_count + 1,
              last_visited_at = excluded.last_visited_at
            """.trimIndent(),
            arrayOf(url, title, faviconUrl, now)
        )
    }

    fun recent(limit: Int = 300, query: String = ""): List<HistoryEntry> {
        val hasQuery = query.isNotBlank()
        val sql = buildString {
            append("SELECT url, title, favicon_url, visit_count, last_visited_at FROM history_visits")
            if (hasQuery) append(" WHERE url LIKE ? OR title LIKE ?")
            append(" ORDER BY last_visited_at DESC LIMIT ?")
        }
        val args = if (hasQuery) {
            arrayOf("%$query%", "%$query%", limit.toString())
        } else {
            arrayOf(limit.toString())
        }
        return helper.readableDatabase.rawQuery(sql, args).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(
                        HistoryEntry(
                            url = cursor.getString(0),
                            title = cursor.getString(1),
                            faviconUrl = cursor.getString(2),
                            visitCount = cursor.getInt(3),
                            lastVisitedAt = cursor.getLong(4)
                        )
                    )
                }
            }
        }
    }

    /** For the sync engine: everything, newest first, bounded by the caller. */
    fun forSync(limit: Int = 20_000): List<HistoryEntry> = recent(limit)

    fun find(url: String): HistoryEntry? =
        helper.readableDatabase.rawQuery(
            "SELECT url, title, favicon_url, visit_count, last_visited_at FROM history_visits WHERE url = ?",
            arrayOf(url)
        ).use { c ->
            if (!c.moveToFirst()) null
            else HistoryEntry(c.getString(0), c.getString(1), c.getString(2), c.getInt(3), c.getLong(4))
        }

    /**
     * Writes an entry that arrived from another device.
     *
     * `visit_count` is deliberately not in the update clause: counts are local,
     * and summing them across devices inflates the number on every sync.
     */
    fun applyRemote(url: String, title: String, faviconUrl: String?, visitedAt: Long) {
        helper.writableDatabase.execSQL(
            """
            INSERT INTO history_visits (url, title, favicon_url, visit_count, last_visited_at)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(url) DO UPDATE SET
              title = excluded.title,
              favicon_url = excluded.favicon_url,
              last_visited_at = excluded.last_visited_at
            """.trimIndent(),
            arrayOf(url, title, faviconUrl, visitedAt)
        )
    }

    fun delete(url: String) {
        helper.writableDatabase.delete("history_visits", "url = ?", arrayOf(url))
    }

    fun clear() {
        helper.writableDatabase.delete("history_visits", null, null)
    }

    /**
     * Removes entries visited at or after [since].
     *
     * A range, not a switch, because "clear my history" almost never means all
     * of it — it means the last hour. Deleting everything when somebody wanted
     * the last twenty minutes is not recoverable, and there is no undo for it.
     *
     * `last_visited_at` is the *most recent* visit, so a page first seen last
     * year but revisited ten minutes ago is inside "the last hour" — which is
     * what somebody clearing the last hour means.
     */
    fun clearSince(since: Long) {
        helper.writableDatabase.delete(
            "history_visits",
            "last_visited_at >= ?",
            arrayOf(since.toString())
        )
    }

    /** How many entries a given range would remove, for the confirmation. */
    fun countSince(since: Long): Int =
        helper.readableDatabase.rawQuery(
            "SELECT COUNT(*) FROM history_visits WHERE last_visited_at >= ?",
            arrayOf(since.toString())
        ).use { if (it.moveToFirst()) it.getInt(0) else 0 }

    fun count(): Int =
        helper.readableDatabase.rawQuery("SELECT COUNT(*) FROM history_visits", null).use {
            if (it.moveToFirst()) it.getInt(0) else 0
        }
}

/**
 * Bookmarks.
 *
 * Every row carries a `guid`, for the same reason the desktop's do: the
 * AUTOINCREMENT primary key is unique on one machine and meaningless on any
 * other, so two devices each creating a bookmark would both call it 7.
 */
class BookmarkStore(private val helper: SlashDatabase) {

    fun add(url: String, title: String, faviconUrl: String? = null): String {
        val guid = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        helper.writableDatabase.insertWithOnConflict(
            "bookmarks",
            null,
            ContentValues().apply {
                put("guid", guid)
                put("url", url)
                put("title", title)
                put("favicon_url", faviconUrl)
                put("is_folder", 0)
                put("sort_order", 0)
                put("created_at", now)
                put("updated_at", now)
            },
            SQLiteDatabase.CONFLICT_REPLACE
        )
        return guid
    }

    fun all(): List<Bookmark> =
        helper.readableDatabase.rawQuery(
            """
            SELECT guid, url, title, favicon_url, parent_guid, is_folder, sort_order, updated_at
              FROM bookmarks ORDER BY sort_order, updated_at DESC
            """.trimIndent(),
            null
        ).use { c ->
            buildList {
                while (c.moveToNext()) {
                    add(
                        Bookmark(
                            guid = c.getString(0),
                            url = c.getString(1),
                            title = c.getString(2),
                            faviconUrl = c.getString(3),
                            parentGuid = c.getString(4),
                            isFolder = c.getInt(5) == 1,
                            sortOrder = c.getInt(6),
                            updatedAt = c.getLong(7)
                        )
                    )
                }
            }
        }

    fun findByUrl(url: String): Bookmark? = all().firstOrNull { it.url == url }

    fun applyRemote(bookmark: Bookmark) {
        helper.writableDatabase.execSQL(
            """
            INSERT INTO bookmarks (guid, url, title, favicon_url, parent_guid, is_folder,
                                   sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(guid) DO UPDATE SET
              url = excluded.url, title = excluded.title,
              favicon_url = excluded.favicon_url, parent_guid = excluded.parent_guid,
              sort_order = excluded.sort_order, updated_at = excluded.updated_at
            """.trimIndent(),
            arrayOf(
                bookmark.guid, bookmark.url, bookmark.title, bookmark.faviconUrl,
                bookmark.parentGuid, if (bookmark.isFolder) 1 else 0, bookmark.sortOrder,
                bookmark.updatedAt, bookmark.updatedAt
            )
        )
    }

    /**
     * Removes a bookmark and records a tombstone **before** the row goes, while
     * its identity can still be read.
     */
    fun remove(guid: String) {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            db.execSQL(
                """
                INSERT INTO sync_tombstones (collection, item_id, deleted_at) VALUES ('bookmarks', ?, ?)
                ON CONFLICT(collection, item_id) DO UPDATE SET deleted_at = excluded.deleted_at
                """.trimIndent(),
                arrayOf(guid, System.currentTimeMillis())
            )
            db.delete("bookmarks", "guid = ?", arrayOf(guid))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun tombstones(): List<Triple<String, String, Long>> =
        helper.readableDatabase.rawQuery(
            "SELECT collection, item_id, deleted_at FROM sync_tombstones", null
        ).use { c ->
            buildList {
                while (c.moveToNext()) add(Triple(c.getString(0), c.getString(1), c.getLong(2)))
            }
        }
}


/** One closed stretch of qualifying time, waiting to be reported. */
data class CoinInterval(
    val id: Long,
    val startedAt: Long,
    val endedAt: Long,
    val seconds: Long
)

/**
 * The coin outbox.
 *
 * Keyed by account, because signing out and back in as somebody else must not
 * hand them the previous person's unreported time.
 */
class CoinStore(private val helper: SlashDatabase) {

    fun add(account: String, startedAt: Long, endedAt: Long, seconds: Long) {
        if (account.isBlank() || seconds <= 0) return
        helper.writableDatabase.execSQL(
            "INSERT INTO coin_intervals (account, started_at, ended_at, seconds) VALUES (?, ?, ?, ?)",
            arrayOf(account, startedAt, endedAt, seconds)
        )
    }

    fun pending(account: String, limit: Int = 200): List<CoinInterval> =
        helper.readableDatabase.rawQuery(
            """
            SELECT id, started_at, ended_at, seconds FROM coin_intervals
             WHERE account = ? ORDER BY started_at LIMIT ?
            """.trimIndent(),
            arrayOf(account, limit.toString())
        ).use { c ->
            buildList {
                while (c.moveToNext()) {
                    add(CoinInterval(c.getLong(0), c.getLong(1), c.getLong(2), c.getLong(3)))
                }
            }
        }

    fun remove(ids: List<Long>) {
        if (ids.isEmpty()) return
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            for (id in ids) db.delete("coin_intervals", "id = ?", arrayOf(id.toString()))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun pendingSeconds(account: String): Long =
        helper.readableDatabase.rawQuery(
            "SELECT COALESCE(SUM(seconds), 0) FROM coin_intervals WHERE account = ?",
            arrayOf(account)
        ).use { if (it.moveToFirst()) it.getLong(0) else 0L }
}
