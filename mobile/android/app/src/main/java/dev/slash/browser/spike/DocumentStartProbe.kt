package dev.slash.browser.spike

import android.content.Context
import org.json.JSONObject

/**
 * Can the shell run a script *before* the page's own scripts?
 *
 * This is the single most valuable capability for Slash specifically. The
 * YouTube ad-field strip works by installing an accessor that deletes
 * `adPlacements`, `playerAds`, `adSlots` and `adBreakHeartbeatParams` before
 * the site's player ever reads them — a script that runs a millisecond late has
 * no effect whatsoever. On desktop that ordering comes from CDP's
 * `Page.addScriptToEvaluateOnNewDocument`, which is why `ScriptletInjector` had
 * to become the single debugger attach point.
 *
 * `WebViewCompat.addDocumentStartJavaScript` is the Android equivalent, and it
 * has no such constraint — there is no single-client limit, so no attach-point
 * bottleneck and no fight with DevTools.
 *
 * The probe runs the page **twice**: once with the script installed and once
 * without. PASS requires the marker present in the first and absent in the
 * second. Without that control, a page that hard-codes the marker itself would
 * pass, which is precisely the failure mode `SLASH_YT_ADS_PROBE` shipped twice.
 */
object DocumentStartProbe {

    /** Installed before any page script. Mirrors what the real strip does. */
    private val INJECTED = """
        (function () {
          Object.defineProperty(window, '__slashMarker', {
            value: 'installed-at-document-start',
            configurable: false,
            writable: false
          });
        })();
    """.trimIndent()

    /**
     * The page's own first script. It reads the marker immediately — before
     * DOMContentLoaded, before anything else — so a marker it can see is a
     * marker that arrived first.
     */
    private val PAGE = """
        <!doctype html><meta charset="utf-8"><title>doc-start</title>
        <script>
          window.__observedAtParse = (typeof window.__slashMarker === 'string')
            ? window.__slashMarker
            : null;
        </script>
        <body>
        <script>
          slashProbe.postMessage(JSON.stringify({
            observedAtParse: window.__observedAtParse,
            stillPresentLater: (typeof window.__slashMarker === 'string')
          }));
        </script>
        </body>
    """.trimIndent()

    suspend fun run(context: Context): ProbeResult {
        val name = "Document-start script injection (scriptlets)"

        val withScript = readMarker(context, inject = true)
        val withoutScript = readMarker(context, inject = false)

        val treatment = withScript.getOrElse { error ->
            return ProbeResult(
                name = name,
                verdict = if (error.message?.contains("unsupported") == true) {
                    Verdict.UNSUPPORTED
                } else {
                    Verdict.INCONCLUSIVE
                },
                detail = "Injected run did not report: ${error.message}"
            )
        }
        val control = withoutScript.getOrElse { error ->
            return ProbeResult(
                name = name,
                verdict = Verdict.INCONCLUSIVE,
                detail = "Control run did not report, so the injected run proves nothing: " +
                    "${error.message}"
            )
        }

        val evidence = mapOf(
            "injected: seen at parse" to (treatment.first ?: "(null)"),
            "control: seen at parse" to (control.first ?: "(null)"),
            "injected: still present" to treatment.second.toString()
        )

        // The control must NOT see the marker. If it does, the page is providing
        // it and the injected run measured nothing.
        if (control.first != null) {
            return ProbeResult(
                name = name,
                verdict = Verdict.INCONCLUSIVE,
                detail = "The control run saw the marker without any injection, so the " +
                    "injected run cannot be attributed to injection.",
                evidence = evidence
            )
        }

        return if (treatment.first == "installed-at-document-start") {
            ProbeResult(
                name = name,
                verdict = Verdict.PASS,
                detail = "The page's own first inline script observed the injected value, " +
                    "and the control run did not. Ordering is guaranteed, so the YouTube " +
                    "field strip and the popup defuser port as-is.",
                evidence = evidence
            )
        } else {
            ProbeResult(
                name = name,
                verdict = Verdict.FAIL,
                detail = "The script did not run before the page's own script. Anything " +
                    "that must win a race against page scripts cannot be built on this.",
                evidence = evidence
            )
        }
    }

    /** Returns (markerSeenAtParse, stillPresentLater). */
    private suspend fun readMarker(
        context: Context,
        inject: Boolean
    ): Result<Pair<String?, Boolean>> {
        val harness = WebProbeHarness(context).serve("/", "text/html", PAGE)
        return harness.run(
            startPath = "/",
            documentStartScript = if (inject) INJECTED else null
        ).map { payload ->
            val json = JSONObject(payload)
            val seen = if (json.isNull("observedAtParse")) null else json.getString("observedAtParse")
            seen to json.optBoolean("stillPresentLater", false)
        }
    }
}
