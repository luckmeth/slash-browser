package dev.slash.browser.spike

import android.content.Context
import androidx.webkit.Profile
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature

/**
 * Can two workspaces hold different sign-ins for the same site?
 *
 * On desktop a workspace owns a `persist:ws-<id>` session partition, and
 * CLAUDE.md is emphatic that isolation is fixed at creation because flipping it
 * later strands every cookie in the old partition. The Android equivalent is
 * androidx.webkit's multi-profile support: each Profile has its own cookie
 * store, its own storage and its own cache.
 *
 * This does not check a feature flag and call it proven. It writes a cookie for
 * the same host into two profiles and reads both back, because a feature that
 * reports supported and then shares a cookie jar would pass a flag check and
 * lose somebody's second account.
 */
object ProfileProbe {

    private const val HOST = "https://spike.slash.test/"

    fun run(@Suppress("UNUSED_PARAMETER") context: Context): ProbeResult {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            return ProbeResult(
                name = "Profile isolation (workspace partitions)",
                verdict = Verdict.UNSUPPORTED,
                detail = "This WebView has no multi-profile support, so workspaces would " +
                    "share one cookie jar. The shell must either require a newer WebView " +
                    "or drop isolated workspaces on this device — it must not pretend.",
                evidence = mapOf("MULTI_PROFILE" to "false")
            )
        }

        val store = ProfileStore.getInstance()
        val alpha: Profile = store.getOrCreateProfile("ws-alpha")
        val beta: Profile = store.getOrCreateProfile("ws-beta")

        val alphaCookies = alpha.cookieManager
        val betaCookies = beta.cookieManager
        alphaCookies.setAcceptCookie(true)
        betaCookies.setAcceptCookie(true)

        alphaCookies.setCookie(HOST, "slash_session=alpha-secret; path=/")
        betaCookies.setCookie(HOST, "slash_session=beta-secret; path=/")

        // Both managers are flushed before reading; without this a read can race
        // the write and produce a null that looks exactly like isolation.
        alphaCookies.flush()
        betaCookies.flush()

        val readAlpha = alphaCookies.getCookie(HOST) ?: ""
        val readBeta = betaCookies.getCookie(HOST) ?: ""

        val evidence = mapOf(
            "profiles" to store.allProfileNames.joinToString(","),
            "alpha reads" to readAlpha.ifEmpty { "(none)" },
            "beta reads" to readBeta.ifEmpty { "(none)" }
        )

        // The control. If neither profile can read back its own cookie, the
        // write failed and the two empty reads are not evidence of isolation.
        if (!readAlpha.contains("alpha-secret") || !readBeta.contains("beta-secret")) {
            return ProbeResult(
                name = "Profile isolation (workspace partitions)",
                verdict = Verdict.INCONCLUSIVE,
                detail = "A profile could not read back its own cookie, so this run says " +
                    "nothing about isolation — two empty reads look identical to two " +
                    "isolated ones.",
                evidence = evidence
            )
        }

        val leaked = readAlpha.contains("beta-secret") || readBeta.contains("alpha-secret")
        return if (leaked) {
            ProbeResult(
                name = "Profile isolation (workspace partitions)",
                verdict = Verdict.FAIL,
                detail = "One profile can read the other's cookie for the same host. " +
                    "Workspaces cannot be built on this.",
                evidence = evidence
            )
        } else {
            ProbeResult(
                name = "Profile isolation (workspace partitions)",
                verdict = Verdict.PASS,
                detail = "Each profile read its own value and neither saw the other's. " +
                    "This is the `persist:ws-<id>` equivalent, and workspaces can rest on it.",
                evidence = evidence
            )
        }
    }
}
