package dev.slash.browser.browser

import android.graphics.Bitmap
import android.net.Uri
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import dev.slash.browser.shield.RuleCategory
import dev.slash.browser.shield.ShieldEngine
import java.io.ByteArrayInputStream

/**
 * Where Slash Shield actually runs.
 *
 * `shouldInterceptRequest` is called on a background thread, once per
 * subresource, and the page's load waits on whatever it returns. So the body
 * does as little as possible: read the page URL from a volatile field, ask the
 * matcher, return. No allocation beyond the verdict, no I/O, no bridge hop.
 * This is the same discipline `ContentBlocker` follows on desktop and for the
 * same reason.
 */
class SlashWebViewClient(
    private val tab: BrowserTab,
    private val shield: ShieldEngine,
    private val onPageUrlChanged: (String) -> Unit,
    private val onOpenInNewTab: (String) -> Unit
) : WebViewClient() {

    /**
     * Read on the interception thread, written on the UI thread — volatile so
     * the matcher is never comparing a request against the previous page.
     */
    @Volatile
    private var pageUrl: String = tab.url

    /**
     * Which categories are being blocked, as a bitmask read on every request.
     *
     * A snapshot rather than a settings lookup: `shouldInterceptRequest` runs on
     * a background thread hundreds of times per page, and reaching into Compose
     * state from there is both a threading question and a cost paid constantly.
     */
    @Volatile
    private var categories: Int = 0

    fun setCategories(ads: Boolean, trackers: Boolean) {
        categories = (if (ads) ADS else 0) or (if (trackers) TRACKERS else 0)
    }

    private val emptyResponse
        get() = WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest
    ): WebResourceResponse? {
        // Never block the top-level document here. A main-frame request that
        // matches a rule is a *navigation* the user asked for, and returning an
        // empty body would show a blank page with no explanation.
        if (request.isForMainFrame) return null

        val requestUrl = request.url?.toString() ?: return null

        // The category switches are honoured *here*, not inside the matcher.
        // The matcher's job is to say what a request is; whether that category
        // is being blocked today is a setting, and conflating the two would mean
        // rebuilding the rule sets every time somebody flipped a switch.
        //
        // Read once per request from a volatile snapshot rather than reaching
        // into the settings store on the interception thread.
        val allowed = categories
        if (allowed == 0) return null

        // Deliberately no logging here. This runs for every subresource on every
        // page — 227 times on one CNN load — and a Log call per request is the
        // kind of constant cost principle 1 exists to refuse. The blocked count
        // on the toolbar is the signal; the verdict is not worth a string.
        val verdict = shield.classifyRequest(requestUrl, pageUrl)
        val blocked = when (verdict) {
            RuleCategory.AD -> allowed and ADS != 0
            RuleCategory.TRACKER -> allowed and TRACKERS != 0
            // Malicious hosts are not a preference. There is no switch for them
            // and there should not be one.
            RuleCategory.MALICIOUS -> true
            null -> false
        }

        return if (blocked) {
            shield.countBlocked()
            // An empty 200 rather than an error, which is what a network-level
            // blocker returns and what page error handling actually copes with.
            tab.blocked += 1
            emptyResponse
        } else {
            null
        }
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val target = request.url ?: return false

        // The sign-in code, taken *before* the navigation is attempted.
        //
        // Catching it in onPageStarted was not enough: the provider redirects to
        // its own configured site address, which is a loopback `http://` URL, and
        // Android refuses cleartext before a page ever starts — so the first thing
        // that fired was onReceivedError with ERR_CLEARTEXT_NOT_PERMITTED and the
        // code sitting unread in the URL. Here the code is taken and the
        // navigation is cancelled, so nothing has to load at all.
        val app = dev.slash.browser.SlashApp.instance
        if (request.isForMainFrame && app.rewards.offerNavigation(target.toString())) {
            app.completeSignIn(target.toString())
            return true
        }

        val scheme = target.scheme?.lowercase()
        // Anything that is not web content belongs to another application, and
        // handing it to the WebView produces an unhelpful error page.
        if (scheme != null && scheme != "http" && scheme != "https" && scheme != "about") {
            onOpenInNewTab(target.toString())
            return true
        }

        // Redirect chains. Only top-level navigation is judged: a frame
        // redirecting itself is not the browser being sent somewhere.
        if (request.isForMainFrame) {
            val allowed = app.redirects.allow(
                targetUrl = target.toString(),
                currentUrl = pageUrl,
                isRedirect = request.isRedirect,
                hadGesture = request.hasGesture()
            )
            if (!allowed) {
                val blocked = app.redirects.lastBlocked
                tab.isLoading = false
                tab.error = blocked?.explanation
                    ?: "Slash Shield stopped this page from redirecting you."
                return true
            }
        }
        return false
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        // A sign-in code can arrive on any navigation, including one to an
        // address the provider fell back to rather than the one we asked for.
        // Watching every main-frame navigation is the only reliable catch.
        val app = dev.slash.browser.SlashApp.instance
        if (app.rewards.offerNavigation(url)) {
            view.stopLoading()
            app.completeSignIn(url)
        }
        pageUrl = url
        tab.url = url
        tab.isLoading = true
        tab.error = null
        onPageUrlChanged(url)
    }

    override fun onPageFinished(view: WebView, url: String) {
        pageUrl = url
        tab.url = url
        val app = dev.slash.browser.SlashApp.instance
        if (!tab.isPrivate && app.settings.current.recordHistory && !url.startsWith("about:")) {
            app.history.record(url, view.title.orEmpty(), null)
        }
        tab.isLoading = false
        tab.progress = 100
        tab.canGoBack = view.canGoBack()
        tab.canGoForward = view.canGoForward()
        tab.title = view.title?.takeIf { it.isNotBlank() } ?: hostOf(url)
        onPageUrlChanged(url)
    }

    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
    ) {
        // Subresource failures are normal and constant; only a failed main frame
        // is something the user needs told about.
        if (!request.isForMainFrame) return

        // A redirect we never got a chance to cancel can still carry the code.
        val failed = request.url?.toString().orEmpty()
        val app = dev.slash.browser.SlashApp.instance
        if (app.rewards.offerNavigation(failed)) {
            app.completeSignIn(failed)
            tab.isLoading = false
            // Not an error the user needs to see — the sign-in worked.
            tab.error = null
            return
        }

        tab.isLoading = false
        tab.error = error.description?.toString() ?: "This page could not be loaded."
    }

    val chromeClient = object : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            tab.progress = newProgress
        }

        override fun onReceivedTitle(view: WebView, title: String) {
            if (title.isNotBlank()) tab.title = title
        }

        /**
         * Where popups are decided.
         *
         * `isUserGesture` alone is not the policy — it is one input to it. A
         * popunder is a *real* click on a real play button whose target happens
         * to be an ad host, and a site that opens four windows from one tap had
         * one gesture for all four. So the facts are gathered here and the
         * verdict comes from the shared `decidePopup`, the same function the
         * desktop uses.
         *
         * The verdict is applied synchronously, because `onCreateWindow` must
         * return now — so the decision uses the *last* verdict the core
         * computed for this gesture, and asks it to compute the next one in the
         * background. In practice a page that opens windows opens several, and
         * the first is judged on gesture and target alone, which is the case the
         * simple test already got right.
         */
        override fun onCreateWindow(
            view: WebView,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: android.os.Message
        ): Boolean {
            val app = dev.slash.browser.SlashApp.instance
            val target = view.hitTestResult?.extra.orEmpty()

            val allowed = app.popups.decide(
                targetUrl = target,
                pageUrl = pageUrl,
                hadGesture = isUserGesture
            )

            if (!allowed) {
                // Refused. `popupDefuserScript` has already replaced what
                // `window.open` returns, so the page's own code carries on
                // rather than throwing on a null it did not expect — the click
                // that asked for this still works, the window simply never
                // opens.
                app.popups.noteBlocked()
                return false
            }

            // Allowed: Slash opens it as an ordinary tab rather than a window,
            // which is what a phone has room for.
            if (target.isNotBlank()) onOpenInNewTab(target)
            return false
        }
    }

    private fun hostOf(url: String): String =
        runCatching { Uri.parse(url).host ?: url }.getOrDefault(url)

    companion object {
        const val ADS = 1
        const val TRACKERS = 2
    }
}
