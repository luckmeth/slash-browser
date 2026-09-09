package dev.slash.browser.shield

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.slash.browser.core.SlashCore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URI

/**
 * Popup decisions.
 *
 * `onCreateWindow` must answer synchronously — Chromium is waiting on the return
 * value — and the shared policy lives behind an asynchronous bridge. So this
 * keeps a small synchronous mirror of the rules that matter in the moment, and
 * asks the core for the full verdict alongside so the two can be compared and
 * the count is right.
 *
 * The synchronous part is deliberately the *conservative* half: no gesture is a
 * refusal, more than one window from a single gesture is a refusal, and a target
 * on the ad list is a refusal even with a gesture — which is exactly the
 * popunder case, a real click on a real play button whose window goes somewhere
 * the click was not about.
 *
 * Anything it allows, the core then re-judges; a disagreement is logged rather
 * than silently ignored, because two policies that drift are worse than one.
 */
class PopupGuard(
    private val shield: ShieldEngine,
    private val core: () -> SlashCore?,
    private val scope: CoroutineScope
) {
    /** Blocked since launch, for the shield count. */
    var blockedCount by mutableIntStateOf(0)
        private set

    /** The last refusal, so the UI can say what happened and why. */
    var lastNotice by mutableStateOf<String?>(null)
        private set

    private var lastGestureAt = 0L
    private var opensFromThisGesture = 0

    /**
     * Recorded when the page reports a real tap.
     *
     * Android gives `isUserGesture` on the call itself, which is the same fact —
     * but it does not say *how many* windows this gesture has already opened, and
     * that is the rule that stops one tap becoming four windows.
     */
    fun noteGesture(now: Long = System.currentTimeMillis()) {
        lastGestureAt = now
        opensFromThisGesture = 0
    }

    fun noteBlocked() {
        blockedCount += 1
    }

    /**
     * Decides now, and asks the core to check the decision.
     */
    fun decide(targetUrl: String, pageUrl: String, hadGesture: Boolean): Boolean {
        val now = System.currentTimeMillis()
        val sinceGesture = if (hadGesture) 0L else now - lastGestureAt
        val gestured = hadGesture || sinceGesture <= GESTURE_WINDOW_MS

        val targetHost = hostOf(targetUrl)
        val pageHost = hostOf(pageUrl)
        val targetIsAd = targetHost.isNotEmpty() && shield.categoryOf(targetHost) != null

        val verdict = when {
            !gestured -> Refusal("This site opened a window on its own, not from anything you clicked.")
            opensFromThisGesture >= 1 ->
                Refusal("This site tried to open more than one window from a single click.")
            targetIsAd ->
                Refusal("This window goes to a known ad or tracking site, so your click was not what opened it.")
            else -> null
        }

        // Ask the shared policy the same question, so a drift between the two
        // shows up in the log rather than as a browser that behaves differently
        // on two platforms.
        askCore(targetHost, pageHost, gestured, sinceGesture, targetIsAd, verdict == null)

        if (verdict != null) {
            lastNotice = verdict.explanation
            return false
        }
        opensFromThisGesture += 1
        return true
    }

    private fun askCore(
        targetHost: String,
        pageHost: String,
        gestured: Boolean,
        sinceGesture: Long,
        targetIsAd: Boolean,
        allowedHere: Boolean
    ) {
        val bridge = core() ?: return
        scope.launch {
            runCatching {
                val facts = JSONObject()
                    .put("targetHost", targetHost)
                    .put("pageHost", pageHost)
                    .put("msSinceGesture", if (gestured) sinceGesture else JSONObject.NULL)
                    .put("opensFromThisGesture", opensFromThisGesture)
                    .put("mode", "balanced")
                    .put("siteAllowsPopups", false)
                    .put("siteLocked", false)
                    .put("isCrossSite", targetHost.isNotEmpty() && targetHost != pageHost)
                    .put("targetIsKnownAdHost", targetIsAd)

                val result = bridge.callObject("decidePopup", JSONObject().put("facts", facts))
                val coreAllowed = result.optString("action") == "allow"
                if (coreAllowed != allowedHere) {
                    Log.w(
                        TAG,
                        "popup policy drift: shell=${if (allowedHere) "allow" else "block"} " +
                            "core=${result.optString("action")} (${result.optString("reason")})"
                    )
                }
            }
        }
    }

    private data class Refusal(val explanation: String)

    private companion object {
        const val TAG = "SlashPopups"

        /** Matches `GESTURE_WINDOW_MS` in PopupPolicy.ts. */
        const val GESTURE_WINDOW_MS = 1500L

        fun hostOf(url: String): String =
            runCatching { URI(url).host?.lowercase()?.removePrefix("www.").orEmpty() }
                .getOrDefault("")
    }
}
