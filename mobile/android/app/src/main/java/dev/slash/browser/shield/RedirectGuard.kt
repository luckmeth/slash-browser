package dev.slash.browser.shield

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.net.URI

/**
 * Redirect chains.
 *
 * `shouldOverrideUrlLoading` must answer synchronously, so the decision is made
 * here and the shared `decideRedirect` is not on the path — but the *ordering*
 * that matters most is reproduced exactly, and it is the ordering that makes
 * this quiet rather than loud:
 *
 *  1. **Identity providers are exempt first**, before anything can form an
 *     opinion. A sign-in flow is *supposed* to cross five domains. Warning about
 *     that teaches people that redirect warnings are noise, which disarms the
 *     warning for the case it exists to catch — so the exemption is checked
 *     ahead of every other rule, including on the hop *back* from the provider.
 *  2. **An ad destination reached without a click blocks.** This is the one case
 *     with a rule behind it rather than a heuristic, and it is the behaviour
 *     somebody means by "it redirected me to an ad".
 *  3. Everything else is allowed. A chain that merely looks busy is recorded and
 *     not interrupted.
 *
 * A tap anywhere in the page counts as a click for `GESTURE_VOUCH_MS`, because a
 * redirect the user started by tapping a link is a redirect they asked for —
 * even when its destination is unpleasant.
 */
class RedirectGuard(private val shield: ShieldEngine) {

    var blockedCount by mutableIntStateOf(0)
        private set

    /** The last refusal, for the notice on the error page. */
    var lastBlocked by mutableStateOf<Blocked?>(null)
        private set

    data class Blocked(val host: String, val explanation: String)

    /** host -> when it entered the chain. Trimmed, so a long session cannot grow it. */
    private val chain = ArrayDeque<Pair<String, Long>>()
    private var lastGestureAt = 0L

    fun noteGesture(now: Long = System.currentTimeMillis()) {
        lastGestureAt = now
    }

    /** A new top-level navigation the user typed or chose; the old chain is over. */
    fun reset() {
        chain.clear()
    }

    /**
     * Returns true to allow.
     *
     * @param isRedirect whether Chromium reported this as a redirect rather than
     *   a fresh navigation. A redirect nobody clicked is the interesting case;
     *   a navigation the user initiated is not.
     */
    fun allow(
        targetUrl: String,
        currentUrl: String,
        isRedirect: Boolean,
        hadGesture: Boolean,
        now: Long = System.currentTimeMillis()
    ): Boolean {
        val target = hostOf(targetUrl)
        if (target.isEmpty()) return true

        chain.addLast(target to now)
        while (chain.size > MAX_CHAIN) chain.removeFirst()

        // 1. Identity and payment providers, both directions.
        if (isExempt(target)) return true
        val previous = chain.elementAtOrNull(chain.size - 2)?.first
        if (previous != null && isExempt(previous)) return true

        val clicked = hadGesture || (now - lastGestureAt) <= GESTURE_VOUCH_MS

        // 2. An ad destination, reached without a click.
        if (!clicked && shield.categoryOf(target) != null) {
            blockedCount += 1
            lastBlocked = Blocked(
                host = target,
                explanation = "This page tried to send you to $target, which is on a list of " +
                    "known advertising or tracking hosts, and nothing you tapped asked for it."
            )
            return false
        }

        // A rapid run of distinct hosts nobody clicked. Recorded, not blocked —
        // "looks busy" is not evidence, and a browser that refuses on suspicion
        // breaks sites it does not understand.
        if (!clicked && isRedirect && distinctRecentHosts(now) >= RAPID_HOSTS) {
            lastBlocked = null
        }
        return true
    }

    private fun distinctRecentHosts(now: Long): Int =
        chain.filter { now - it.second <= RAPID_WINDOW_MS }.map { it.first }.distinct().size

    private companion object {
        /** Matches GESTURE_VOUCH_MS in RedirectChainMonitor.ts. */
        const val GESTURE_VOUCH_MS = 5_000L
        const val RAPID_WINDOW_MS = 4_000L
        const val RAPID_HOSTS = 3
        const val MAX_CHAIN = 12

        /**
         * Providers that legitimately run multi-hop cross-domain chains.
         *
         * A subset of `AUTH_HOSTS` in `redirectChain.ts` — the ones a phone
         * browser actually meets. It will never be complete, which is why an
         * unrecognised chain is *allowed* rather than blocked: not knowing a
         * bank is not evidence against it.
         */
        val EXEMPT = listOf(
            "accounts.google.com", "accounts.youtube.com", "login.microsoftonline.com",
            "login.live.com", "login.microsoft.com", "appleid.apple.com", "idmsa.apple.com",
            "github.com", "gitlab.com", "auth0.com", "okta.com", "onelogin.com",
            "duosecurity.com", "facebook.com", "linkedin.com", "twitter.com", "x.com",
            "paypal.com", "stripe.com", "checkout.stripe.com", "adyen.com",
            "braintreegateway.com", "klarna.com", "squareup.com", "authorize.net",
            "supabase.co", "supabase.io", "amazoncognito.com"
        )

        fun isExempt(host: String): Boolean =
            EXEMPT.any { host == it || host.endsWith(".$it") }

        fun hostOf(url: String): String =
            runCatching { URI(url).host?.lowercase()?.removePrefix("www.").orEmpty() }
                .getOrDefault("")
    }
}
