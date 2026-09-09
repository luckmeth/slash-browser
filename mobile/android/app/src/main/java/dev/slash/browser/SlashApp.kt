package dev.slash.browser

import android.app.Application
import android.util.Log
import dev.slash.browser.core.SlashCore
import dev.slash.browser.data.BookmarkStore
import dev.slash.browser.data.CoinStore
import dev.slash.browser.data.HistoryStore
import dev.slash.browser.browser.SessionStore
import dev.slash.browser.browser.TabManager
import dev.slash.browser.data.SlashDatabase
import dev.slash.browser.rewards.RewardsService
import dev.slash.browser.settings.SettingsStore
import dev.slash.browser.sponsor.SponsorService
import dev.slash.browser.updates.UpdateService
import dev.slash.browser.sync.SyncEngine
import dev.slash.browser.shield.PathRule
import dev.slash.browser.shield.RuleCategory
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import dev.slash.browser.downloads.DownloadManager
import dev.slash.browser.downloads.YtDlpService
import dev.slash.browser.shield.PopupGuard
import dev.slash.browser.shield.RedirectGuard
import dev.slash.browser.shield.ShieldEngine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Scripts that must run before a page's own, taken from the desktop verbatim.
 *
 * Empty strings are a valid state — the core may not have loaded — and every
 * caller checks, because installing an empty document-start script is a silent
 * no-op that looks exactly like a working blocker.
 */
data class Scriptlets(
    val youtubeAds: String = "",
    val popupDefuser: String = "",
    val contextMenu: String = ""
)

class SlashApp : Application() {

    val shield = ShieldEngine()
    private val scope = CoroutineScope(SupervisorJob())

    // Created lazily so nothing opens a database file before onCreate has run.
    private val database by lazy { SlashDatabase(this) }
    val history by lazy { HistoryStore(database) }
    val bookmarks by lazy { BookmarkStore(database) }
    val settings by lazy { SettingsStore(this) }
    val session by lazy { SessionStore(this) }
    val popups by lazy { PopupGuard(shield, { sharedCore }, scope) }
    val redirects by lazy { RedirectGuard(shield) }

    /**
     * A real touch in a page.
     *
     * Both guards need it and neither can observe it themselves: `onCreateWindow`
     * is told whether *that call* had a gesture, and a redirect is told nothing
     * at all. The WebView reports the touch, and one call feeds both — so a tap
     * vouches for the window and the navigation that follow it, which is what a
     * person means when they say they clicked something.
     */
    fun noteGesture() {
        popups.noteGesture()
        redirects.noteGesture()
    }
    val updates by lazy { UpdateService(this) }
    val ytDlp by lazy { YtDlpService(this) }
    val downloads by lazy { DownloadManager(this, ytDlp, scope) }

    private var tabs: TabManager? = null
    private var sessionJob: Job? = null

    fun attachTabs(manager: TabManager) {
        tabs = manager
    }

    /**
     * Records the session ~4s after the tabs stop changing.
     *
     * Debounced because opening a window of twenty tabs is twenty changes, and
     * written *as it happens* rather than at exit — a session saved only on an
     * orderly quit is not saved at all for the users who most need it, and on
     * Android the system kills backgrounded browsers without asking.
     */
    fun noteTabsChanged() {
        if (!settings.current.restoreTabsOnLaunch) return
        sessionJob?.cancel()
        sessionJob = scope.launch {
            delay(4_000)
            val manager = tabs ?: return@launch
            val (rows, index) = manager.snapshot()
            session.save(rows, index)
        }
    }
    val coins by lazy { CoinStore(database) }
    val rewards by lazy { RewardsService(this, coins) { sharedCore } }
    val sync by lazy { SyncEngine(settings, history, bookmarks) }

    /**
     * Creative acceptance is asked of the shared core rather than re-decided
     * here: both rules are privacy promises, and a second implementation is a
     * second chance to get one wrong.
     */
    val sponsors by lazy {
        SponsorService(this, settings) { row ->
            val core = sharedCore ?: return@SponsorService false
            runCatching {
                core.callObject("acceptCreative", JSONObject().put("creative", row))
                    .optBoolean("ok")
            }.getOrDefault(false)
        }
    }

    /**
     * Kept for the life of the process.
     *
     * The earning clock asks it what counts on every sample, and creative
     * vetting asks it on every batch — so freeing it after startup would mean
     * re-loading a WebView and re-evaluating the bundle to answer a question
     * every thirty seconds.
     */
    private var sharedCore: SlashCore? = null

    /** Completes once the shield has its rules, so the first tab can wait on it. */
    val shieldReady = CompletableDeferred<Boolean>()

    var scriptlets = Scriptlets()
        private set

    /** Set when the core could not be loaded, so the UI can say so rather than imply blocking works. */
    var coreError: String? = null
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        scope.launch { loadCore() }
    }

    /**
     * Slash is no longer in front of anybody.
     *
     * Runs on the application scope on purpose: the activity's scope is being
     * cancelled as this is called, and an interval that closes but is never
     * written is time somebody earned and lost.
     */
    /** Exchanges an auth code seen on a navigation, off the UI thread. */
    fun completeSignIn(url: String) {
        scope.launch {
            if (rewards.completeSignIn(url)) Log.i(TAG, "signed in to Slash Coin")
        }
    }

    /**
     * Deletes what the private workspace accumulated.
     *
     * Called when the last private tab closes, which is the moment the promise
     * on that screen comes due. `Profile.getWebStorage().deleteAllData()` and
     * the profile's own cookie manager, not a global clear — wiping every
     * profile would sign the user out of Personal and Work as well, which is a
     * far worse outcome than the one this is meant to prevent.
     */
    fun clearPrivateData() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
        runCatching {
            val profile = ProfileStore.getInstance().getProfile(PRIVATE_PROFILE) ?: return
            profile.cookieManager.removeAllCookies(null)
            profile.webStorage.deleteAllData()
            Log.i(TAG, "private workspace data cleared")
        }.onFailure { Log.w(TAG, "could not clear private data", it) }
    }

    fun onAppPaused() {
        // Written immediately here rather than waiting out the debounce: the
        // process may not survive long enough for a delayed write to run.
        if (settings.current.restoreTabsOnLaunch) {
            tabs?.snapshot()?.let { (rows, index) -> session.save(rows, index) }
        }
        scope.launch {
            rewards.pause()
            // Same moment: aggregated advert counts go out with the coin
            // intervals rather than on their own timer, so a backgrounded
            // browser makes one burst of requests instead of two.
            sponsors.reportCounts()
        }
    }

    private suspend fun loadCore() {
        val core = SlashCore.create(this)
        if (core == null) {
            coreError = "The shared core did not load, so no filter rules are active."
            Log.e(TAG, coreError!!)
            shieldReady.complete(false)
            return
        }

        try {
            val lists = core.callObject("shieldLists")
            shield.load(
                ads = lists.stringList("ads"),
                trackers = lists.stringList("trackers"),
                malicious = lists.stringList("malicious"),
                pathRules = lists.pathRules()
            )

            val scripts = core.callObject("scripts")
            scriptlets = Scriptlets(
                youtubeAds = scripts.optString("youtubeAds"),
                popupDefuser = scripts.optString("popupDefuser"),
                contextMenu = scripts.optString("contextMenu")
            )

            Log.i(TAG, "shield ready: ${shield.ruleCount} rules")
            if (settings.current.clearHistoryOnExit) {
                // Applied at launch rather than at exit: a process that is killed
                // by the system never gets an exit hook, so clearing there would
                // be a promise kept only for orderly shutdowns.
                history.clear()
                Log.i(TAG, "history cleared on launch, per settings")
            }
            shieldReady.complete(true)
        } catch (error: Exception) {
            coreError = "The core loaded but its rules could not be read: ${error.message}"
            Log.e(TAG, coreError!!, error)
            shieldReady.complete(false)
        } finally {
            // Kept only if sponsored tiles need it to vet creatives; otherwise
            // freed, because holding a WebView open for the life of the process
            // to answer nothing is a renderer sitting in memory for no reason.
            sharedCore = core
            if (sponsors.isActive) {
                scope.launch {
                    // Cache first, so a cold start shows the batch somebody paid
                    // for without waiting on a network round trip.
                    sponsors.loadCache()
                    sponsors.refresh()
                }
            }
        }
    }

    private fun JSONObject.stringList(key: String): List<String> {
        val array = optJSONArray(key) ?: JSONArray()
        return (0 until array.length()).mapNotNull { array.optString(it).takeIf(String::isNotEmpty) }
    }

    private fun JSONObject.pathRules(): List<PathRule> {
        val array = optJSONArray("pathRules") ?: JSONArray()
        return (0 until array.length()).mapNotNull { index ->
            val entry = array.optJSONObject(index) ?: return@mapNotNull null
            val host = entry.optString("host")
            val path = entry.optString("path")
            if (host.isEmpty() || path.isEmpty()) return@mapNotNull null
            val category = when (entry.optString("category")) {
                "tracker" -> RuleCategory.TRACKER
                else -> RuleCategory.AD
            }
            PathRule(host, path, category)
        }
    }

    companion object {
        private const val TAG = "SlashApp"

        /** Must match the workspace id, since that is what names the profile. */
        const val PRIVATE_PROFILE = "private"
        lateinit var instance: SlashApp
            private set
    }
}
