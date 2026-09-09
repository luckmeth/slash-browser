package dev.slash.browser.spike

import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * SLASH_ANDROID_SPIKE — the four unknowns of Phase B0, measured rather than assumed.
 *
 * The Android plan rests on four claims, and each is the kind that is cheap to
 * believe and expensive to be wrong about:
 *
 *   1. Profiles genuinely isolate cookies      → workspaces are possible
 *   2. shouldInterceptRequest can refuse       → network ad blocking is possible
 *   3. A script can run before page scripts    → the YouTube strip ports
 *   4. The desktop's pure core runs unmodified → only the I/O half is a rewrite
 *
 * If any of these fails, the answer is GeckoView and it is much better to learn
 * that in week one than in month four. Results go to the screen and to logcat
 * under the tag below, so a CI run can read them without a human.
 *
 *   adb logcat -s SLASH_ANDROID_SPIKE
 */
class SpikeActivity : AppCompatActivity() {

    private lateinit var output: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        output = TextView(this).apply {
            textSize = 12f
            setPadding(32, 48, 32, 48)
            gravity = Gravity.START
            typeface = android.graphics.Typeface.MONOSPACE
            text = "SLASH_ANDROID_SPIKE\nrunning…"
        }
        setContentView(ScrollView(this).apply { addView(output) })

        lifecycleScope.launch { runAll() }
    }

    private suspend fun runAll() {
        val header = buildString {
            appendLine("SLASH_ANDROID_SPIKE")
            appendLine("=".repeat(58))
            val pkg = WebViewCompat.getCurrentWebViewPackage(this@SpikeActivity)
            appendLine("WebView   : ${pkg?.packageName ?: "unknown"} ${pkg?.versionName ?: ""}")
            appendLine("Android   : ${android.os.Build.VERSION.RELEASE} (API ${android.os.Build.VERSION.SDK_INT})")
            appendLine("Device    : ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
            appendLine("=".repeat(58))
        }
        show(header)

        val results = mutableListOf<ProbeResult>()

        // Measured, not assumed: `ProfileStore.getOrCreateProfile` throws
        // "Must be called on the UI thread" off-main, even though it touches a
        // cookie store rather than a renderer. The first version of this file
        // ran it on Dispatchers.Default with a comment explaining why that was
        // safe, and the device disagreed on the first run. Every androidx.webkit
        // entry point here is main-thread-only.
        results += ProfileProbe.run(this)
        show(header + render(results))

        // The remaining three each drive a WebView and must stay on main too.
        results += InterceptProbe.run(this)
        show(header + render(results))

        results += DocumentStartProbe.run(this)
        show(header + render(results))

        results += JsCoreProbe.run(this)
        show(header + render(results))

        // Pure computation, no WebView, so it can run anywhere — but kept in
        // the same probe run because it answers a question of the same kind:
        // does this platform agree with the desktop about something neither can
        // check at runtime?
        results += SyncCryptoProbe.run()

        val summary = buildString {
            appendLine()
            appendLine("=".repeat(58))
            val counts = results.groupingBy { it.verdict }.eachCount()
            appendLine(
                Verdict.entries.joinToString("  ") { "${it.name}=${counts[it] ?: 0}" }
            )
            val blocking = results.filter { it.verdict == Verdict.FAIL }
            appendLine(
                when {
                    blocking.isNotEmpty() ->
                        "VERDICT: WebView cannot carry Slash as planned. " +
                            "Re-run Phase B0 against GeckoView before writing the shell."
                    results.any { it.verdict != Verdict.PASS } ->
                        "VERDICT: incomplete — some probes did not conclude. " +
                            "Nothing is proven by a run that did not measure."
                    else ->
                        "VERDICT: all four Phase B0 claims hold. Proceed to B1 (shell)."
                }
            )
        }

        val full = header + render(results) + summary
        show(full)
        for (line in full.lines()) Log.i(TAG, line)
    }

    private fun render(results: List<ProbeResult>): String =
        results.joinToString("\n\n") { it.render() }

    private suspend fun show(text: String) = withContext(Dispatchers.Main) {
        output.text = text
    }

    private companion object {
        const val TAG = "SLASH_ANDROID_SPIKE"
    }
}
