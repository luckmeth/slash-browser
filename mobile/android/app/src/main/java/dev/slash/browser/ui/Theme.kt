package dev.slash.browser.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Slash's design tokens, taken from `src/renderer/styles.css`.
 *
 * These are the desktop's values, not an interpretation of them. The first
 * version of this file invented an orange Material palette with a light mode,
 * and the result was recognisably not the same product.
 *
 * Two things carry over exactly:
 *
 *   - **The accent is blue.** `#6ea8fe`, and it is the only accent — the lock
 *     glyph is `--color-good` green and errors are `--color-bad`, but nothing
 *     in this browser is orange.
 *   - **There is no light mode.** The desktop chrome is a dark glass system
 *     over Windows acrylic. A light variant would not be "the same browser in
 *     daylight", it would be a different design.
 *
 * What cannot carry over is the acrylic itself: the desktop's translucency
 * blurs the user's *wallpaper* through the window, which an Android app has
 * nothing equivalent to — there is no desktop behind it. So the glass layers
 * are flattened onto `--color-surface` at their own alpha, which is exactly
 * what `styles.css` already does for Windows 10 and for machines with
 * transparency switched off. The colours are the ones that degraded path
 * produces, so this is the documented fallback rather than a new palette.
 */
object Slash {
    // @theme tokens
    val Surface = Color(0xFF0D0F14)
    val SurfaceRaised = Color(0xFF151922)
    val BorderSubtle = Color(0xFF262C3A)
    val TextPrimary = Color(0xFFF2F5FA)
    val TextMuted = Color(0xFFB9C2D4)
    val Accent = Color(0xFF6EA8FE)
    val Good = Color(0xFF58D39B)
    val Bad = Color(0xFFF2777A)
    val Warn = Color(0xFFE8B465)

    /**
     * The glass layers, composited over `Surface`.
     *
     * `--glass-base: rgba(14,17,24,0.55)` over `#0d0f14` resolves to very nearly
     * `#0d0f14` itself, which is why the chrome bars read as almost the same
     * value as the page ground — that is correct, and the separation on desktop
     * comes from the hairline edge rather than from a fill difference.
     */
    val GlassBase = Color(0xFF0E1118)
    val GlassRaised = Color(0xFF1B2130)
    val GlassHigh = Color(0xFF262E3F)
    val GlassPage = Color(0xFF0B0D12)
    val GlassPanel = Color(0xFF131720)

    val GlassHover = Color(0x1AFFFFFF)   // rgba(255,255,255,0.10)
    val GlassActive = Color(0x2EFFFFFF)  // rgba(255,255,255,0.18)
    val GlassEdge = Color(0x24FFFFFF)    // rgba(255,255,255,0.14)
    val GlassEdgeStrong = Color(0x47FFFFFF) // rgba(255,255,255,0.28)

    /**
     * Behind a bottom sheet. Dark enough that the sheet reads as the thing in
     * front, light enough that the page is still visibly there — a sheet over an
     * opaque ground looks like a navigation, not an overlay.
     */
    val Scrim = Color(0x99000000)
}

/** Exposed so composables can read tokens the Material scheme has no slot for. */
val LocalSlash = staticCompositionLocalOf { Slash }

@Composable
fun SlashTheme(content: @Composable () -> Unit) {
    // Dark only, deliberately. See the note above.
    val scheme = darkColorScheme(
        primary = Slash.Accent,
        onPrimary = Slash.Surface,
        background = Slash.GlassPage,
        onBackground = Slash.TextPrimary,
        surface = Slash.GlassBase,
        onSurface = Slash.TextPrimary,
        surfaceVariant = Slash.GlassRaised,
        onSurfaceVariant = Slash.TextMuted,
        outline = Slash.GlassEdge,
        error = Slash.Bad,
        onError = Slash.Surface
    )
    CompositionLocalProvider(LocalSlash provides Slash) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
