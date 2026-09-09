package dev.slash.browser.core

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/**
 * Hosts the shared TypeScript core.
 *
 * `mobile/core/entry.ts` is bundled by esbuild into a single IIFE with no
 * imports and no module system, and evaluated here in a headless WebView — V8,
 * already in the process, no extra runtime to ship. The same bundle is intended
 * to run in JavaScriptCore on iOS, which is why the surface is one function
 * taking and returning JSON rather than anything engine-specific.
 *
 * Everything called through here is a **cold path**: rules and scripts fetched
 * once at startup, a download planned once. The hot paths — per-request filter
 * matching, segment transfer — are native, because an asynchronous hop per
 * subresource is exactly the latency principle 1 forbids.
 */
class SlashCore private constructor(private val webView: WebView) {

    companion object {
        private const val TAG = "SlashCore"

        /** Nothing here should take a second; ten is a hang, not slowness. */
        private const val LOAD_TIMEOUT_MS = 10_000L
        private const val CALL_TIMEOUT_MS = 5_000L

        /**
         * Loads the bundle and returns a ready core, or null if it could not be
         * loaded.
         *
         * Null is a real state the caller must handle: the browser still works
         * without the core, it simply has no filter rules, and saying so beats
         * pretending the lists are empty on purpose. Every await here is bounded
         * — the first version was not, and a callback that never fired left the
         * whole app waiting on a shield that would never arrive, with no first
         * tab and no error to explain it.
         */
        @SuppressLint("SetJavaScriptEnabled")
        suspend fun create(context: Context): SlashCore? = withContext(Dispatchers.Main) {
            val bundle = runCatching {
                context.assets.open("core/slash-core.js").bufferedReader().use { it.readText() }
            }.getOrElse {
                Log.e(TAG, "core bundle missing from assets — run: npm run core:build", it)
                return@withContext null
            }

            val webView = WebView(context)
            webView.settings.javaScriptEnabled = true

            // The bundle needs a real document to attach globalThis to.
            // Evaluating into a WebView that has never finished a load works on
            // some builds and silently does nothing on others, so the load is
            // awaited rather than assumed.
            val loaded = CompletableDeferred<Unit>()
            webView.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    if (!loaded.isCompleted) loaded.complete(Unit)
                }
            }
            webView.loadUrl("about:blank")

            if (withTimeoutOrNull(LOAD_TIMEOUT_MS) { loaded.await() } == null) {
                Log.e(TAG, "about:blank never finished loading")
                webView.destroy()
                return@withContext null
            }

            val evaluated = CompletableDeferred<String>()
            webView.evaluateJavascript("$bundle; typeof globalThis.SlashCore") {
                evaluated.complete(it ?: "")
            }
            val type = withTimeoutOrNull(LOAD_TIMEOUT_MS) { evaluated.await() }

            if (type == null || !type.contains("object")) {
                Log.e(TAG, "bundle evaluated but SlashCore is $type")
                webView.destroy()
                return@withContext null
            }
            SlashCore(webView)
        }
    }

    /**
     * Calls a core function. Returns the `value` from the bridge's envelope, or
     * throws with the core's own error message — the bridge never lets a JS
     * throw cross as a native exception, so a failure here is always a message.
     */
    suspend fun call(name: String, args: JSONObject = JSONObject()): Any? =
        withContext(Dispatchers.Main) {
            val expression =
                "SlashCore.call(${JSONObject.quote(name)}, ${JSONObject.quote(args.toString())})"

            val raw = CompletableDeferred<String>()
            webView.evaluateJavascript(expression) { raw.complete(it ?: "") }
            val result = withTimeoutOrNull(CALL_TIMEOUT_MS) { raw.await() }
                ?: throw IllegalStateException("core call '$name' timed out")

            // evaluateJavascript hands back a JSON *literal*, so the bridge's
            // string arrives quoted and escaped and has to be unwrapped once.
            val unwrapped = if (result.startsWith("\"")) {
                JSONObject("{\"v\":$result}").getString("v")
            } else {
                result
            }

            val envelope = JSONObject(unwrapped)
            if (!envelope.optBoolean("ok")) {
                throw IllegalStateException(envelope.optString("error", "unknown core error"))
            }
            envelope.opt("value")
        }

    suspend fun callObject(name: String, args: JSONObject = JSONObject()): JSONObject =
        call(name, args) as? JSONObject
            ?: throw IllegalStateException("core function $name did not return an object")

    /**
     * Frees the host WebView.
     *
     * Hops to the main thread itself rather than requiring callers to. Every
     * WebView method must run on the thread the view was created on, and this
     * one is called from a `finally` in a coroutine whose dispatcher is not the
     * caller's choice — the first version threw
     * "A WebView method was called on thread 'DefaultDispatcher-worker-1'" and
     * took the process down *after* the shield had loaded successfully, which
     * looked like the shield being the problem.
     */
    fun destroy() {
        Handler(Looper.getMainLooper()).post { webView.destroy() }
    }
}
