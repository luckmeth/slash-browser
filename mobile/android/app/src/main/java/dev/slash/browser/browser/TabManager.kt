package dev.slash.browser.browser

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.toMutableStateList

/** A workspace is a WebView profile plus a name. Isolation is fixed at creation. */
data class Workspace(val id: String, val name: String, val isPrivate: Boolean = false)

/**
 * Tabs and workspaces.
 *
 * Workspace isolation is **fixed at creation and cannot be toggled**, the same
 * rule the desktop enforces: a workspace owns its WebView `Profile`, and moving
 * a tab across that boundary would strand every cookie it holds. So a tab
 * belongs to the workspace it was created in for its whole life.
 *
 * `MAX_LIVE_VIEWS` is the one piece of resource management that is honest on
 * Android. Every attached WebView is a live renderer in a single shared process,
 * and the OS kills that process under pressure whether or not the browser has an
 * opinion — so the browser keeps the count low itself, and hibernates the least
 * recently used tab rather than letting Android decide which to lose.
 */
class TabManager(
    /** Called whenever the set of tabs changes, so the session can be recorded. */
    private val onChanged: () -> Unit = {},
    /** Read live, so changing the setting takes effect without a restart. */
    private val liveBudget: () -> Int = { MAX_LIVE_VIEWS },
    /** Called when the last private tab closes, to delete that profile's data. */
    private val onPrivateEmptied: () -> Unit = {}
) {

    val workspaces = listOf(
        Workspace("default", "Personal"),
        Workspace("work", "Work"),
        // Private is a workspace rather than a separate mode, because it already
        // is one: a WebView Profile with its own cookie jar. What makes it
        // private is that history is not recorded from it and the profile's data
        // is deleted when the last private tab closes — stated in the UI, since
        // "private" means different things in different browsers and a phone
        // gives no room to find out afterwards.
        Workspace("private", "Private", isPrivate = true)
    ).toMutableStateList()

    var activeWorkspaceId by mutableStateOf("default")
        private set

    val tabs = mutableListOf<BrowserTab>().toMutableStateList()

    var activeTabId by mutableStateOf(-1L)
        private set

    private var nextId = 1L
    private val recentlyUsed = ArrayDeque<Long>()

    val visibleTabs: List<BrowserTab>
        get() = tabs.filter { it.workspaceId == activeWorkspaceId }

    val activeTab: BrowserTab?
        get() = tabs.firstOrNull { it.id == activeTabId }

    val isPrivate: Boolean
        get() = workspaces.firstOrNull { it.id == activeWorkspaceId }?.isPrivate == true

    fun newTab(url: String = HOME_URL, workspaceId: String = activeWorkspaceId): BrowserTab {
        val private = workspaces.firstOrNull { it.id == workspaceId }?.isPrivate == true
        val tab = BrowserTab(nextId++, workspaceId, url, isPrivate = private)
        tabs.add(tab)
        select(tab.id)
        onChanged()
        return tab
    }

    /** Restores a saved session without selecting or rendering as it goes. */
    fun restore(saved: List<SavedTab>, activeIndex: Int) {
        for (entry in saved) {
            tabs.add(BrowserTab(nextId++, entry.workspaceId, entry.url).also {
                it.title = entry.title
            })
        }
        val chosen = tabs.getOrNull(activeIndex) ?: tabs.lastOrNull()
        if (chosen != null) {
            activeWorkspaceId = chosen.workspaceId
            select(chosen.id)
        }
    }

    fun snapshot(): Pair<List<SavedTab>, Int> {
        // Private tabs are not restored, which is most of what private means on
        // a phone — the browser reopening them a day later in front of somebody
        // else is the failure this avoids.
        val rows = tabs.filter { !it.isPrivate }.map { SavedTab(it.url, it.title, it.workspaceId) }
        return rows to tabs.indexOfFirst { it.id == activeTabId }.coerceAtLeast(0)
    }

    fun select(id: Long) {
        // A picture of the tab being left, for the switcher.
        if (id != activeTabId) activeTab?.captureThumbnail()
        activeTabId = id
        recentlyUsed.remove(id)
        recentlyUsed.addLast(id)
        enforceLiveBudget()
    }

    fun switchWorkspace(id: String) {
        if (id == activeWorkspaceId) return
        activeTab?.captureThumbnail()
        activeWorkspaceId = id
        val existing = tabs.firstOrNull { it.workspaceId == id }
        if (existing != null) select(existing.id) else newTab(workspaceId = id)
    }

    fun close(id: Long) {
        val index = tabs.indexOfFirst { it.id == id }
        if (index < 0) return
        val tab = tabs[index]
        val wasActive = tab.id == activeTabId
        tab.destroy()
        tabs.removeAt(index)
        recentlyUsed.remove(id)

        onChanged()
        // The last private tab taking its data with it is the whole promise.
        if (tab.isPrivate && tabs.none { it.isPrivate }) onPrivateEmptied()
        if (!wasActive) return
        val remaining = visibleTabs
        if (remaining.isEmpty()) newTab() else select(remaining.last().id)
    }

    fun closeAllInWorkspace(workspaceId: String) {
        tabs.filter { it.workspaceId == workspaceId }.forEach { close(it.id) }
    }

    /**
     * Hibernates the least recently used tab once too many renderers are live.
     *
     * Deliberately not "sleep anything the user has not touched for N minutes":
     * a button press or a timer is not a reason to destroy a half-filled form,
     * and the desktop routes every such decision through one place for exactly
     * that reason. The only trigger here is the budget being exceeded.
     */
    private fun enforceLiveBudget() {
        val budget = liveBudget().coerceAtLeast(1)
        val live = tabs.filter { it.webView != null }
        if (live.size <= budget) return

        val order = recentlyUsed.toList()
        live.sortedBy { tab -> order.indexOf(tab.id).let { if (it < 0) Int.MIN_VALUE else it } }
            .take(live.size - budget)
            .filter { it.id != activeTabId }
            .forEach { it.hibernate() }
    }

    companion object {
        const val HOME_URL = "about:blank"

        /**
         * Android runs every WebView in one shared renderer process, so each
         * live view costs memory in a process the OS is already eyeing. Four is
         * a budget, not a limit anybody asked for.
         */
        const val MAX_LIVE_VIEWS = 4
    }
}
