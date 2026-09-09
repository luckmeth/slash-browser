package dev.slash.browser.spike

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import java.io.ByteArrayInputStream

/**
 * A WebView that serves its own pages, so a probe's result depends on nothing
 * but the WebView.
 *
 * Every page and subresource is answered from [routes] inside
 * `shouldInterceptRequest`. Nothing reaches the network, which means a probe
 * cannot pass because some server happened to answer, and a run on a
 * disconnected machine means exactly what a run on a connected one means.
 */
class WebProbeHarness(private val context: Context) {

    /** path -> (mimeType, body). A path absent from this map is *blocked*. */
    private val routes = mutableMapOf<String, Pair<String, String>>()

    /** Every path the page actually requested, in order, for the evidence table. */
    val requested = mutableListOf<String>()

    /** Paths the interceptor refused. */
    val blocked = mutableListOf<String>()

    private val messages = CompletableDeferred<String>()

    fun serve(path: String, mimeType: String, body: String) = apply {
        routes[path] = mimeType to body
    }

    @SuppressLint("SetJavaScriptEnabled")
    suspend fun run(
        startPath: String,
        documentStartScript: String? = null,
        timeoutMs: Long = 15_000
    ): Result<String> {
        val webView = WebView(context)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true

        // The bridge the real shell will use. `addJavascriptInterface` is the
        // older route and injects into every frame with no origin control;
        // this one is scoped and does not expose reflection.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(
                webView,
                "slashProbe",
                setOf("*")
            ) { _, message, _, _, _ ->
                if (!messages.isCompleted) messages.complete(message.data ?: "")
            }
        } else {
            return Result.failure(IllegalStateException("WEB_MESSAGE_LISTENER unsupported"))
        }

        if (documentStartScript != null) {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                return Result.failure(IllegalStateException("DOCUMENT_START_SCRIPT unsupported"))
            }
            WebViewCompat.addDocumentStartJavaScript(webView, documentStartScript, setOf("*"))
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val path = request.url.path ?: "/"
                synchronized(requested) { requested.add(path) }

                val route = routes[path]
                if (route == null) {
                    synchronized(blocked) { blocked.add(path) }
                    // An empty 200 rather than an error status: this is what a
                    // network-level blocker returns, and it is what the page's
                    // own error handling has to cope with.
                    return WebResourceResponse(
                        "text/plain",
                        "utf-8",
                        ByteArrayInputStream(ByteArray(0))
                    )
                }
                val (mime, body) = route
                return WebResourceResponse(mime, "utf-8", ByteArrayInputStream(body.toByteArray()))
            }
        }

        webView.loadUrl("https://spike.slash.test$startPath")

        return try {
            val data = withTimeout(timeoutMs) { messages.await() }
            Result.success(data)
        } catch (_: TimeoutCancellationException) {
            Result.failure(IllegalStateException("page never reported back within ${timeoutMs}ms"))
        } finally {
            webView.stopLoading()
            webView.destroy()
        }
    }
}
