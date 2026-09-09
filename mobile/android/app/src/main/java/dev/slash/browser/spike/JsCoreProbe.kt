package dev.slash.browser.spike

import android.content.Context
import org.json.JSONObject

/**
 * Does the desktop's own pure logic run here, unmodified, and get the same answers?
 *
 * This is Phase A's entire thesis under test. `scripts/core-boundary.mjs`
 * measures that 128 source files of policy, planning and parsing never reach
 * `electron`, a native module or a node builtin; `mobile/core/build.mjs` bundles
 * a slice of them into a 4.7 KB IIFE with no imports. If that bundle computes
 * the same values on a device that it computes on the desktop, then Android and
 * iOS need to rewrite only the I/O half of Slash rather than all of it.
 *
 * The assertion that matters is the **coverage invariant**. Work-stealing is the
 * one part of the download engine that corrupts a file without failing anything:
 * a gap or an overlap does not throw, does not fail a request, and does not stop
 * the download reaching 100% — it writes a file that opens, plays for a while,
 * and is wrong in the middle. So the shell checks it here, against the real
 * `planSplit`, rather than trusting that a port preserved it.
 */
object JsCoreProbe {

    /**
     * Exercises the core and returns its answers. Loaded after the bundle, in
     * the same JS context, so `SlashCore` is already attached to globalThis.
     */
    private val DRIVER = """
        <!doctype html><meta charset="utf-8"><title>core</title>
        <body>
        <script src="/core/slash-core.js"></script>
        <script>
          (function () {
            function call(name, args) {
              return JSON.parse(SlashCore.call(name, JSON.stringify(args || {})));
            }
            var out = { loaded: typeof SlashCore === 'object' };
            try {
              out.version = call('version').value;

              // A 10 MB file, one connection, 1 MB already on disk. A second
              // connection goes idle and steals half the unfetched remainder.
              var segments = [{ index: 0, start: 0, end: 9999999, receivedBytes: 1000000 }];
              var plan = call('planSplit', { segments: segments, nextIndex: 1 }).value;
              out.plan = plan;

              // Apply the steal exactly as SegmentedDownload would, then assert
              // the result still tiles [0, total) with no gap and no overlap.
              var after = [
                { index: 0, start: 0, end: plan.donorNewEnd, receivedBytes: 1000000 },
                plan.fresh
              ];
              out.coverage = call('checkCoverage', { segments: after, total: 10000000 }).value;

              // A manifest named after its role in the protocol, not the film.
              out.filename = call('mediaFilename', {
                pageTitle: 'The Matrix - YouTube',
                url: 'https://x.test/hls/1080/index.m3u8'
              }).value;

              // Credentials and clock params stripped, real identity kept.
              out.identity = call('mediaIdentity', {
                url: 'https://x.test/v?id=7&expire=123&sig=abc'
              }).value;

              out.classified = call('classifyFailure', { error: { status: 403 } }).value;
            } catch (e) {
              out.threw = String(e);
            }
            slashProbe.postMessage(JSON.stringify(out));
          })();
        </script>
        </body>
    """.trimIndent()

    suspend fun run(context: Context): ProbeResult {
        val name = "Shared TypeScript core (Phase A)"

        val bundle = try {
            context.assets.open("core/slash-core.js").bufferedReader().use { it.readText() }
        } catch (error: Exception) {
            return ProbeResult(
                name = name,
                verdict = Verdict.INCONCLUSIVE,
                detail = "The core bundle is not in assets. Run: npm run core:build",
                evidence = mapOf("error" to String(error.message.orEmpty().toByteArray()))
            )
        }

        val harness = WebProbeHarness(context)
            .serve("/", "text/html", DRIVER)
            .serve("/core/slash-core.js", "application/javascript", bundle)

        val payload = harness.run(startPath = "/").getOrElse { error ->
            return ProbeResult(
                name = name,
                verdict = Verdict.INCONCLUSIVE,
                detail = "The driver never reported back: ${error.message}",
                evidence = mapOf("bundle bytes" to bundle.toByteArray().size.toString())
            )
        }

        val json = JSONObject(payload)
        if (json.has("threw")) {
            return ProbeResult(
                name = name,
                verdict = Verdict.FAIL,
                detail = "The core threw on device: ${json.getString("threw")}",
                evidence = mapOf("bundle bytes" to bundle.toByteArray().size.toString())
            )
        }

        val plan = json.optJSONObject("plan")
        val coverage = json.optJSONObject("coverage")
        val filename = json.optString("filename")
        val identity = json.optString("identity")

        val evidence = mapOf(
            "bundle bytes" to bundle.toByteArray().size.toString(),
            "functions" to (json.optJSONObject("version")?.optJSONArray("functions")?.toString()
                ?: "(none)"),
            "planSplit donorNewEnd" to (plan?.optLong("donorNewEnd")?.toString() ?: "(none)"),
            "planSplit fresh.start" to
                (plan?.optJSONObject("fresh")?.optLong("start")?.toString() ?: "(none)"),
            "coverage" to (coverage?.toString() ?: "(none)"),
            "mediaFilename" to filename,
            "mediaIdentity" to identity,
            "classifyFailure" to (json.optJSONObject("classified")?.optString("kind") ?: "(none)")
        )

        if (!json.optBoolean("loaded")) {
            return ProbeResult(
                name = name,
                verdict = Verdict.FAIL,
                detail = "The bundle loaded but did not attach SlashCore to globalThis.",
                evidence = evidence
            )
        }

        // The same values the desktop produces. Checked rather than displayed,
        // because a probe that only prints numbers relies on somebody reading them.
        val failures = buildList {
            if (plan?.optLong("donorNewEnd") != 5_499_999L) add("planSplit donorNewEnd")
            if (plan?.optJSONObject("fresh")?.optLong("start") != 5_500_000L) add("planSplit fresh.start")
            if (coverage?.optBoolean("ok") != true) add("coverage invariant")
            if (filename != "The Matrix") add("mediaFilename")
            if (identity != "https://x.test/v?id=7") add("mediaIdentity")
            if (json.optJSONObject("classified")?.optString("kind") != "permanent") add("classifyFailure")
        }

        return if (failures.isEmpty()) {
            ProbeResult(
                name = name,
                verdict = Verdict.PASS,
                detail = "The desktop's own pure logic ran unmodified on device and returned " +
                    "identical values, coverage invariant included. Only the I/O half of " +
                    "Slash needs a native rewrite.",
                evidence = evidence
            )
        } else {
            ProbeResult(
                name = name,
                verdict = Verdict.FAIL,
                detail = "The core ran but disagreed with the desktop on: " +
                    failures.joinToString(", ") + ". A shared core that computes different " +
                    "answers per platform is worse than two implementations.",
                evidence = evidence
            )
        }
    }
}
