package dev.slash.browser.shield

import android.net.Uri

/** What a rule blocked something as. Mirrors `RuleCategory` in FilterEngine.ts. */
enum class RuleCategory { AD, TRACKER, MALICIOUS }

data class PathRule(val host: String, val path: String, val category: RuleCategory)

/**
 * Slash Shield's matcher, ported to Kotlin.
 *
 * This is the one piece of shield logic that is **not** shared with the desktop,
 * and the reason is principle 1. `shouldInterceptRequest` fires for every
 * subresource on every page — hundreds per page load — and it runs on a
 * background thread that the page's own loading waits on. Routing each request
 * through the JS core would mean an asynchronous hop on the browsing path, which
 * is precisely the latency the first principle forbids. The rules still come
 * from `defaultLists.ts` at startup; only the match is native.
 *
 * A port that quietly disagrees with the original is worse than no port, so
 * `ShieldEngineTest` runs the same cases `FilterEngine.test.ts` runs — including
 * the ones that exist because a live probe found them: `google.lk/pagead/lvz`
 * sailing past a rule written for `google.com`, and `google.com.evil.example`
 * which must *not* match.
 */
class ShieldEngine {

    private val ads = HashSet<String>()
    private val trackers = HashSet<String>()
    private val malicious = HashSet<String>()
    private val allowed = HashSet<String>()
    private val pathRules = ArrayList<PathRule>()

    var blockedCount: Long = 0L
        private set

    fun load(
        ads: List<String>,
        trackers: List<String>,
        malicious: List<String>,
        pathRules: List<PathRule>
    ) {
        this.ads.addAll(ads.map(::normalise).filter { it.isNotEmpty() })
        this.trackers.addAll(trackers.map(::normalise).filter { it.isNotEmpty() })
        this.malicious.addAll(malicious.map(::normalise).filter { it.isNotEmpty() })
        this.pathRules.addAll(
            pathRules.map { PathRule(normalise(it.host), it.path.lowercase(), it.category) }
        )
    }

    val ruleCount: Int get() = ads.size + trackers.size + malicious.size

    /** Per-site exemption — the user's own "this site is fine" list. */
    fun setAllowedSites(hosts: List<String>) {
        allowed.clear()
        allowed.addAll(hosts.map(::normalise))
    }

    fun isSiteAllowed(pageHost: String): Boolean = matches(allowed, normalise(pageHost))

    fun isMalicious(host: String): Boolean = matches(malicious, normalise(host))

    /**
     * Trackers first, so a host on both lists reports as the more specific one.
     */
    fun categoryOf(host: String): RuleCategory? {
        val clean = normalise(host)
        if (matches(trackers, clean)) return RuleCategory.TRACKER
        if (matches(ads, clean)) return RuleCategory.AD
        return null
    }

    /**
     * Host+path rules, checked *before* the first-party test — which is the whole
     * point of them existing, since the endpoints they target are served by the
     * site the user is already on.
     */
    fun classifyUrl(url: String): RuleCategory? {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return null
        val host = normalise(uri.host ?: return null)
        if (host.isEmpty()) return null
        val path = (uri.path ?: "/").lowercase()

        for (rule in pathRules) {
            if (!hostMatches(rule.host, host)) continue
            if (path.startsWith(rule.path)) return rule.category
        }
        return null
    }

    /**
     * The single decision point for subresource blocking.
     *
     * Third-party only. A first-party request to a domain that happens to be on
     * the list is left alone: if somebody deliberately visits an ad network's
     * own site, blocking it would look like the browser is broken.
     */
    fun classifyRequest(requestUrl: String, pageUrl: String): RuleCategory? {
        val requestHost = hostOf(requestUrl) ?: return null
        val pageHost = hostOf(pageUrl) ?: return null
        if (requestHost.isEmpty() || pageHost.isEmpty()) return null

        if (isSiteAllowed(pageHost)) return null
        if (matches(malicious, requestHost)) return RuleCategory.MALICIOUS

        // Path rules reach first-party endpoints, so they are tested before the
        // same-site exemption rather than after it.
        classifyUrl(requestUrl)?.let { return it }

        if (isSameSite(requestHost, pageHost)) return null
        return categoryOf(requestHost)
    }

    /**
     * Convenience for callers with no category preferences. The browser itself
     * uses `classifyRequest` and applies the user's switches, because *what a
     * request is* and *whether that category is blocked today* are different
     * questions and only the first belongs in a matcher.
     */
    fun shouldBlock(requestUrl: String, pageUrl: String): Boolean =
        classifyRequest(requestUrl, pageUrl) != null

    /** Counted by the caller, since the caller makes the final decision. */
    fun countBlocked() {
        blockedCount += 1
    }

    fun resetCount() {
        blockedCount = 0
    }

    private companion object {
        fun hostOf(url: String): String? =
            runCatching { normalise(Uri.parse(url).host ?: "") }.getOrNull()

        fun normalise(value: String): String =
            value.trim().lowercase().removePrefix("www.")

        /**
         * Whether `host` is `rule` or a subdomain of it.
         *
         * A rule ending in `.*` matches the same name under any top-level
         * domain: `google.*` covers google.com, google.lk and google.co.uk.
         * Google serves the same ad endpoints from every country domain it
         * operates, and listing ~190 of them by hand was the alternative.
         */
        fun hostMatches(rule: String, host: String): Boolean {
            if (rule.endsWith(".*")) {
                val base = Regex.escape(rule.dropLast(2))
                // `google.co.uk` and `google.com` both qualify; `notgoogle.com`
                // does not, and neither does `google.com.evil.example` — the
                // name must own the tail.
                return Regex("(^|\\.)$base(\\.[a-z]{2,}){1,2}$").containsMatchIn(host)
            }
            return host == rule || host.endsWith(".$rule")
        }

        /** Walks up the domain tree so a rule covers its subdomains. */
        fun matches(set: Set<String>, host: String): Boolean {
            if (host.isEmpty()) return false
            if (set.contains(host)) return true
            var index = host.indexOf('.')
            while (index != -1) {
                if (set.contains(host.substring(index + 1))) return true
                index = host.indexOf('.', index + 1)
            }
            return false
        }

        /**
         * Approximate same-site test, deliberately the same approximation the
         * desktop makes. Comparing the last two labels is right for
         * `example.com` and wrong for `co.uk`, where `a.co.uk` and `b.co.uk`
         * read as one site. The failure is conservative — it blocks *less*,
         * never more — so the worst outcome is an advert getting through rather
         * than a page being broken. A Public Suffix List is the obvious upgrade.
         */
        fun isSameSite(a: String, b: String): Boolean {
            if (a == b) return true
            fun tail(h: String) = h.split('.').takeLast(2).joinToString(".")
            return tail(a) == tail(b)
        }
    }
}
