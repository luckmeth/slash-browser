package dev.slash.browser.browser

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** One tab as it survives a restart: address, title, and which workspace it was in. */
data class SavedTab(val url: String, val title: String, val workspaceId: String)

/**
 * The session, so reopening Slash reopens what you had.
 *
 * Written **as the tabs change**, debounced, rather than at exit. The desktop
 * learned this the expensive way: a session written only on an orderly quit is
 * not written at all for the users who most need it, because a crash or a
 * force-stop writes nothing. On Android that is not an edge case — the system
 * kills backgrounded browsers routinely, and it never asks first.
 *
 * What is kept is the address, the title and the workspace. Not scroll position
 * and not form state: `WebView.saveState` could carry the back-forward list, but
 * its `Bundle` is not something to serialise to disk by hand, and a restore that
 * silently dropped half a saved state would be worse than one that plainly
 * reopens the page.
 */
class SessionStore(context: Context) {

    private val file = File(context.filesDir, "session.json")

    fun save(tabs: List<SavedTab>, activeIndex: Int) {
        runCatching {
            val json = JSONObject()
                .put("activeIndex", activeIndex)
                .put(
                    "tabs",
                    JSONArray().apply {
                        for (tab in tabs) {
                            put(
                                JSONObject()
                                    .put("url", tab.url)
                                    .put("title", tab.title)
                                    .put("workspaceId", tab.workspaceId)
                            )
                        }
                    }
                )
            file.writeText(json.toString())
        }.onFailure { Log.w(TAG, "could not write session", it) }
    }

    fun load(): Pair<List<SavedTab>, Int> {
        if (!file.exists()) return emptyList<SavedTab>() to 0
        return runCatching {
            val json = JSONObject(file.readText())
            val array = json.optJSONArray("tabs") ?: JSONArray()
            val tabs = buildList {
                for (i in 0 until array.length()) {
                    val row = array.optJSONObject(i) ?: continue
                    val url = row.optString("url")
                    // A saved start page is not worth restoring as a tab — it is
                    // what a new window shows anyway.
                    if (url.isBlank() || url == TabManager.HOME_URL) continue
                    add(
                        SavedTab(
                            url = url,
                            title = row.optString("title").ifBlank { url },
                            workspaceId = row.optString("workspaceId").ifBlank { "default" }
                        )
                    )
                }
            }
            tabs to json.optInt("activeIndex", 0)
        }.getOrElse {
            // A damaged session file must not stop the browser opening. Losing a
            // session is a disappointment; failing to start is a bug report.
            Log.w(TAG, "could not read session; starting fresh", it)
            emptyList<SavedTab>() to 0
        }
    }

    fun clear() {
        runCatching { file.delete() }
    }

    private companion object {
        const val TAG = "SlashSession"
    }
}
