package dev.slash.browser.spike

/**
 * A probe reports one of four things, and three of them are not "it works".
 *
 * The desktop project learned this the expensive way: `SLASH_YT_ADS_PROBE`
 * asked "is an advert on screen" once, seconds after load, and reported PASS
 * on a page that showed an advert moments later — twice, and it was believed
 * both times. A probe that cannot distinguish "the thing works" from "the
 * conditions for testing it never arose" is worse than no probe, because it
 * produces confident wrong answers.
 *
 * So UNSUPPORTED and INCONCLUSIVE are first-class results here, and every probe
 * below refuses to return PASS unless it also observed its own control.
 */
enum class Verdict {
    /** The capability was exercised and behaved as the shell will need it to. */
    PASS,

    /** The capability was exercised and did not behave as needed. A real finding. */
    FAIL,

    /** This WebView does not implement the feature. Not a defect — a floor. */
    UNSUPPORTED,

    /** The test could not be run. Says nothing about the capability either way. */
    INCONCLUSIVE
}

data class ProbeResult(
    val name: String,
    val verdict: Verdict,
    val detail: String,
    val evidence: Map<String, String> = emptyMap()
) {
    fun render(): String {
        val head = "[$verdict] $name\n    $detail"
        if (evidence.isEmpty()) return head
        val body = evidence.entries.joinToString("\n") { "      ${it.key} = ${it.value}" }
        return "$head\n$body"
    }
}
