package dev.slash.browser.browser

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.webkit.WebView
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.slash.browser.SlashApp

/**
 * One tab.
 *
 * The `WebView` is held **optionally**, exactly as `Tab` holds its
 * `WebContentsView` on desktop: a tab with no view is a completely normal tab
 * that simply is not rendering. That is what makes hibernation a state change
 * rather than a refactor — and on Android it matters more than on desktop,
 * because the OS will kill background renderers whether or not the browser has
 * an opinion about it.
 *
 * `savedState` is what a hibernated tab keeps. `WebView.saveState` returns the
 * full back-forward list, which is the direct equivalent of
 * `navigationHistory.restore()` — so a restored tab keeps its history, not just
 * its address.
 */
class BrowserTab(
    val id: Long,
    val workspaceId: String,
    initialUrl: String,
    /** Private tabs record no history and take their profile with them. */
    val isPrivate: Boolean = false
) {
    var url by mutableStateOf(initialUrl)
        internal set
    var title by mutableStateOf("New tab")
        internal set
    var progress by mutableIntStateOf(0)
        internal set
    var canGoBack by mutableStateOf(false)
        internal set
    var canGoForward by mutableStateOf(false)
        internal set
    var blocked by mutableIntStateOf(0)
        internal set
    var isLoading by mutableStateOf(false)
        internal set

    /** Set when a load fails, so the shell can render its own page and say why. */
    var error by mutableStateOf<String?>(null)
        internal set

    var webView: WebView? = null
        private set

    /**
     * A picture of the page, taken when this tab stops being the visible one.
     *
     * Captured at that moment rather than continuously: a thumbnail is worth
     * having in the switcher and worth nothing while the page is on screen, and
     * drawing a WebView into a bitmap is real work. Scaled down on capture, so
     * what is retained is a card-sized image rather than a full-resolution copy
     * of every page.
     *
     * Null is normal and expected — a hibernated tab has no view to draw, which
     * is why the card falls back to the host rather than to a blank rectangle.
     */
    var thumbnail by mutableStateOf<Bitmap?>(null)
        private set

    /**
     * Draws the current page into a small bitmap.
     *
     * Wrapped, because `draw` on a WebView mid-teardown throws, and losing a
     * thumbnail must never take the browser with it.
     */
    fun captureThumbnail() {
        val view = webView ?: return
        if (view.width <= 0 || view.height <= 0) return
        runCatching {
            val scale = THUMBNAIL_WIDTH.toFloat() / view.width
            val bitmap = Bitmap.createBitmap(
                THUMBNAIL_WIDTH,
                (view.height * scale).toInt().coerceAtLeast(1),
                Bitmap.Config.RGB_565
            )
            val canvas = Canvas(bitmap)
            canvas.scale(scale, scale)
            view.draw(canvas)
            thumbnail = bitmap
        }
    }

    private var savedState: Bundle? = null

    /**
     * A navigation the shell asked for that the WebView has not performed yet.
     *
     * Setting `url` alone only changes what the address bar says. The view may
     * not exist (a start-page tab has none), and when it does exist the change
     * has to reach it through the composition rather than from wherever the
     * click happened — so the request is queued here and drained in
     * `PageHost`'s `update`. Without this the address changed and the page did
     * not, which is what a start-page shortcut did.
     */
    private var pending: String? = null

    /** Ask this tab to go somewhere. Safe before the view exists. */
    fun navigate(target: String) {
        error = null
        url = target
        pending = target
    }

    /** Drains the queued navigation, if any. Called from the view's update pass. */
    fun takePendingUrl(): String? {
        val next = pending
        pending = null
        return next
    }

    /**
     * A tab whose renderer was freed *after* it had one.
     *
     * Not simply "has no view": a tab showing the start page has no view either
     * and has lost nothing, and marking it hibernated in the strip told the
     * user their brand-new tab had been put to sleep.
     */
    val isHibernated: Boolean get() = webView == null && savedState != null

    @SuppressLint("SetJavaScriptEnabled")
    fun ensureView(context: Context, clientFactory: (BrowserTab) -> SlashWebViewClient): WebView {
        webView?.let { return it }

        val view = WebView(context)

        // Must happen before anything is loaded: a profile cannot be changed
        // once the WebView has a document, and the whole point of a workspace is
        // that its cookies were never shared in the first place.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            runCatching { WebViewCompat.setProfile(view, workspaceId) }
        }

        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = true
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = true
            userAgentString = userAgentString.replace("; wv", "")
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(view.settings, true)
        }

        val client = clientFactory(this)
        val settings = SlashApp.instance.settings.current
        client.setCategories(ads = settings.blockAds, trackers = settings.blockTrackers)
        view.webViewClient = client
        view.webChromeClient = client.chromeClient

        // A touch anywhere in the page vouches for the window or navigation
        // that follows it. Returning false always: this observes, it never
        // consumes the event, so scrolling and tapping are unaffected.
        view.setOnTouchListener { _, event ->
            if (event.action == android.view.MotionEvent.ACTION_DOWN) {
                SlashApp.instance.noteGesture()
            }
            false
        }

        installScriptlets(view)

        val state = savedState
        if (state != null) {
            view.restoreState(state)
            savedState = null
        } else {
            view.loadUrl(url)
        }
        // The view has just been pointed at `url`; a queued request for the same
        // address would load it a second time.
        pending = null

        webView = view
        return view
    }

    /**
     * Document-start scripts, installed per WebView.
     *
     * Ordering is the entire point — the YouTube strip deletes ad fields before
     * the site's player reads them, and a script that runs a millisecond late
     * has no effect at all. An empty script string is skipped rather than
     * installed, because installing nothing looks identical to blocking working.
     */
    private fun installScriptlets(view: WebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        val scripts = SlashApp.instance.scriptlets
        val settings = SlashApp.instance.settings.current

        // Chosen at view creation, because `addDocumentStartJavaScript` registers
        // against the WebView and there is no API to unregister one. Turning a
        // script off therefore applies to tabs opened afterwards, and the
        // settings copy says so rather than letting somebody discover it — the
        // same honesty the desktop applies to `autoplayPolicy`.
        val wanted = buildList {
            if (settings.blockYouTubeVideoAds) add(scripts.youtubeAds)
            if (settings.defusePopups) add(scripts.popupDefuser)
            if (settings.restoreContextMenu) add(scripts.contextMenu)
        }
        for (script in wanted) {
            if (script.isBlank()) continue
            runCatching { WebViewCompat.addDocumentStartJavaScript(view, script, setOf("*")) }
        }
    }

    /**
     * Frees the renderer while keeping everything needed to rebuild the tab.
     *
     * This is the only state that actually returns memory — the desktop makes
     * the same distinction between FROZEN and HIBERNATED, and quoting a byte
     * figure for anything short of this would be inventing one.
     */
    fun hibernate() {
        val view = webView ?: return
        // Taken before the renderer goes, so a sleeping tab still has a picture.
        captureThumbnail()
        val state = Bundle()
        view.saveState(state)
        savedState = state
        view.stopLoading()
        view.destroy()
        webView = null
        isLoading = false
        progress = 0
    }

    fun destroy() {
        webView?.stopLoading()
        webView?.destroy()
        webView = null
    }
}

private const val THUMBNAIL_WIDTH = 360
