package dev.slash.browser.ui

import android.net.Uri

/**
 * Turns whatever was typed into something to load.
 *
 * Pure, and tested, because the two failure modes are both bad in ways the user
 * blames the browser for: treating a search as a URL produces a DNS error for a
 * sentence, and treating a URL as a search hands the address to a search engine
 * along with anything in its query string.
 */
object Omnibox {

    private val SCHEME = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://")
    private val LOOKS_LIKE_HOST = Regex("^[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+(:\\d+)?(/.*)?$")
    private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?(/.*)?$")

    /** Search URL per engine id, matching the desktop's `UrlResolver`. */
    fun searchUrl(engineId: String, query: String): String = when (engineId) {
        "duckduckgo" -> "https://duckduckgo.com/?q=" + Uri.encode(query)
        "bing" -> "https://www.bing.com/search?q=" + Uri.encode(query)
        // Google is the default, and an unknown id falls back to it rather than
        // to nothing — the desktop's resolver does the same.
        else -> "https://www.google.com/search?q=" + Uri.encode(query)
    }

    fun resolve(input: String, engineId: String = "google"): String {
        val text = input.trim()
        if (text.isEmpty()) return "about:blank"

        // An explicit scheme is a decision the user already made.
        if (SCHEME.containsMatchIn(text)) return text
        if (text.startsWith("about:") || text.startsWith("data:")) return text

        // A bare host with a space in it is a search, whatever it looks like.
        if (!text.contains(' ')) {
            if (text == "localhost" || text.startsWith("localhost:")) return "http://$text"
            if (IPV4.matches(text)) return "http://$text"
            if (LOOKS_LIKE_HOST.matches(text)) return "https://$text"
        }
        return searchUrl(engineId, text)
    }

    /** What the address bar shows: the host, or the whole thing if there isn't one. */
    fun display(url: String): String {
        if (url == "about:blank") return ""
        return runCatching {
            val uri = Uri.parse(url)
            val host = uri.host ?: return url
            host.removePrefix("www.")
        }.getOrDefault(url)
    }

    fun isSecure(url: String): Boolean = url.startsWith("https://")
}
