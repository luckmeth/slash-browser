package dev.slash.browser.spike

import android.content.Context
import org.json.JSONObject

/**
 * Can the shell refuse a request the page makes?
 *
 * This is the whole of network-level ad blocking on Android. On desktop that is
 * `session.webRequest.onBeforeRequest`; here it is
 * `WebViewClient.shouldInterceptRequest`, which runs off the UI thread and can
 * substitute a response.
 *
 * The probe blocks one subresource and allows another, and requires **both**
 * observations. Only checking that the blocked one failed would pass just as
 * happily against a harness where nothing loads at all.
 */
object InterceptProbe {

    private val PAGE = """
        <!doctype html><meta charset="utf-8"><title>intercept</title>
        <body>
        <script>
          // Each fetch resolves either way; what matters is the body we get.
          async function probe(path) {
            try {
              const r = await fetch(path, { cache: 'no-store' });
              const t = await r.text();
              return t.trim();
            } catch (e) {
              return 'threw:' + e;
            }
          }
          (async () => {
            const allowed = await probe('/allowed.txt');
            const tracker = await probe('/tracker.js');
            slashProbe.postMessage(JSON.stringify({
              allowed: allowed,
              tracker: tracker
            }));
          })();
        </script>
        </body>
    """.trimIndent()

    suspend fun run(context: Context): ProbeResult {
        val harness = WebProbeHarness(context)
            .serve("/", "text/html", PAGE)
            .serve("/allowed.txt", "text/plain", "ALLOWED-OK")
        // /tracker.js is deliberately absent, so the harness blocks it.

        val outcome = harness.run(startPath = "/")
        val name = "Request interception (network ad blocking)"

        val payload = outcome.getOrElse { error ->
            return ProbeResult(
                name = name,
                verdict = Verdict.INCONCLUSIVE,
                detail = "The page never reported back, so nothing was measured: " +
                    "${error.message}",
                evidence = mapOf("requested" to harness.requested.joinToString(","))
            )
        }

        val json = JSONObject(payload)
        val allowed = json.optString("allowed")
        val tracker = json.optString("tracker")

        val evidence = mapOf(
            "allowed body" to allowed.ifEmpty { "(empty)" },
            "tracker body" to tracker.ifEmpty { "(empty)" },
            "requested" to harness.requested.joinToString(","),
            "blocked" to harness.blocked.joinToString(",")
        )

        // Control first: if the allowed resource did not arrive, the harness
        // itself is broken and the blocked one proves nothing.
        if (allowed != "ALLOWED-OK") {
            return ProbeResult(
                name = name,
                verdict = Verdict.INCONCLUSIVE,
                detail = "The control resource did not load, so an empty tracker body is " +
                    "not evidence of blocking — it is evidence the harness failed.",
                evidence = evidence
            )
        }

        return if (tracker.isEmpty()) {
            ProbeResult(
                name = name,
                verdict = Verdict.PASS,
                detail = "The allowed resource arrived and the blocked one came back empty, " +
                    "decided in shouldInterceptRequest. Network-level blocking works.",
                evidence = evidence
            )
        } else {
            ProbeResult(
                name = name,
                verdict = Verdict.FAIL,
                detail = "The blocked resource still delivered a body. The interceptor is " +
                    "not authoritative and blocking cannot rest on it.",
                evidence = evidence
            )
        }
    }
}
