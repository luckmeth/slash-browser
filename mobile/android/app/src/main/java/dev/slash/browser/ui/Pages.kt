package dev.slash.browser.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.slash.browser.SlashApp
import dev.slash.browser.browser.BrowserTab
import dev.slash.browser.browser.TabManager
import dev.slash.browser.ui.panels.Panel

/**
 * The start page, laid out for a phone.
 *
 * The first Android build reproduced the desktop's new tab page and it read as a
 * desktop page shrunk down — which is what "it feels like the PC version" meant.
 * This follows the shape a phone browser actually uses: a large wordmark, a
 * search pill you tap rather than a toolbar field you aim at, one row of round
 * shortcuts, a card of destinations, and a feed section at the bottom.
 *
 * The feed slot is **Sponsored**. Chrome puts a content feed there; Slash has no
 * editorial feed to put in it and inventing one would mean deciding what people
 * should read. What goes there instead is the thing the browser is honest about
 * selling — labelled, batched, and counted without identifying anybody.
 */
@Composable
fun StartPage(tabs: TabManager, onOpenPanel: (Panel) -> Unit = {}, onFocusOmnibox: () -> Unit = {}) {
    val app = SlashApp.instance
    val shortcuts = listOf(
        Shortcut("Wikipedia", "https://en.wikipedia.org"),
        Shortcut("YouTube", "https://www.youtube.com"),
        Shortcut("Reddit", "https://www.reddit.com"),
        Shortcut("GitHub", "https://github.com"),
        Shortcut("Hacker News", "https://news.ycombinator.com")
    )

    fun open(url: String) {
        val tab = tabs.activeTab
        if (tab == null) tabs.newTab(url) else tab.navigate(url)
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(Slash.GlassPage)
            .verticalScroll(rememberScrollState())
    ) {
        Spacer(Modifier.height(56.dp))

        // The wordmark, at the size a phone start page uses it. Slash, not a
        // search engine's name: this is the browser's own page.
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            BrandMark(size = 34.dp, color = Slash.TextPrimary)
            Spacer(Modifier.width(10.dp))
            Text(
                "Slash",
                fontSize = 38.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = (-0.5).sp,
                color = Slash.TextPrimary
            )
        }

        Spacer(Modifier.height(22.dp))

        // A pill, not a text field. Tapping it moves focus to the real omnibox,
        // so there is one place text is entered and one set of suggestions —
        // two search fields on one screen is the mistake this shape avoids.
        Row(
            Modifier
                .padding(horizontal = 20.dp)
                .fillMaxWidth()
                .background(Slash.GlassRaised, CircleShape)
                .border(1.dp, Slash.GlassEdge, CircleShape)
                .clickable(onClick = onFocusOmnibox)
                .padding(horizontal = 18.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icons.Default.Search, null, Modifier.size(18.dp), tint = Slash.TextMuted)
            Spacer(Modifier.width(12.dp))
            Text("Search or type a web address", fontSize = 15.sp, color = Slash.TextMuted)
        }

        Spacer(Modifier.height(24.dp))

        // Round icons in a scrolling row — the phone convention, and it means
        // adding a sixth shortcut costs nothing rather than breaking a grid.
        LazyRow(
            contentPadding = PaddingValues(horizontal = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp)
        ) {
            items(shortcuts, key = { it.url }) { shortcut ->
                Column(
                    Modifier.width(64.dp).clickable { open(shortcut.url) },
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Box(
                        Modifier.size(52.dp).background(Slash.GlassRaised, CircleShape),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            shortcut.name.first().uppercase(),
                            fontSize = 20.sp,
                            fontWeight = FontWeight.Medium,
                            color = Slash.TextPrimary
                        )
                    }
                    Spacer(Modifier.height(7.dp))
                    Text(
                        shortcut.name,
                        fontSize = 11.sp,
                        color = Slash.TextMuted,
                        maxLines = 2,
                        textAlign = TextAlign.Center,
                        lineHeight = 13.sp
                    )
                }
            }
        }

        Spacer(Modifier.height(26.dp))

        // The destinations card, matching what a phone browser puts here.
        Column(
            Modifier
                .padding(horizontal = 16.dp)
                .fillMaxWidth()
                .background(Slash.GlassRaised, RoundedCornerShape(18.dp))
                .border(1.dp, Slash.GlassEdge, RoundedCornerShape(18.dp))
                .padding(vertical = 16.dp)
        ) {
            Text(
                "Shortcuts",
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = Slash.TextPrimary,
                modifier = Modifier.padding(start = 18.dp, bottom = 14.dp)
            )
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                DestinationButton(Icons.Default.Bookmark, "Bookmarks") { onOpenPanel(Panel.BOOKMARKS) }
                DestinationButton(Icons.Default.History, "History") { onOpenPanel(Panel.HISTORY) }
                DestinationButton(Icons.Default.Download, "Downloads") { onOpenPanel(Panel.DOWNLOADS) }
                DestinationButton(Icons.Default.Shield, "Shield") { onOpenPanel(Panel.SETTINGS) }
            }
        }

        Spacer(Modifier.height(24.dp))

        SponsoredSection(tabs)

        Spacer(Modifier.height(28.dp))

        Text(
            when {
                app.coreError != null -> "Shield inactive — ${app.coreError}"
                app.shield.ruleCount == 0 -> "Shield is still loading its rules."
                else -> "Slash Shield · ${app.shield.ruleCount} rules · " +
                    "${app.shield.blockedCount} blocked this session"
            },
            fontSize = 11.sp,
            textAlign = TextAlign.Center,
            color = if (app.coreError != null) Slash.Warn else Slash.TextMuted,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp)
        )
        Spacer(Modifier.height(36.dp))
    }
}

private data class Shortcut(val name: String, val url: String)

@Composable
private fun DestinationButton(icon: ImageVector, label: String, onClick: () -> Unit) {
    Column(
        Modifier.width(72.dp).clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            Modifier.size(44.dp).background(Slash.GlassHigh, RoundedCornerShape(12.dp)),
            contentAlignment = Alignment.Center
        ) {
            Icon(icon, null, Modifier.size(20.dp), tint = Slash.Accent)
        }
        Spacer(Modifier.height(7.dp))
        Text(label, fontSize = 11.sp, color = Slash.TextMuted, maxLines = 1)
    }
}

/**
 * Where a content feed would be.
 *
 * Always present as a heading, because an advert that appears in a slot which is
 * otherwise empty reads as the page glitching. When there is no campaign the
 * section says what the slot is for — which is also the honest answer, and it is
 * the only place in the browser that mentions advertising to somebody who has
 * not gone looking for it.
 */
@Composable
private fun SponsoredSection(tabs: TabManager) {
    val app = SlashApp.instance
    val tile = if (app.sponsors.isActive) app.sponsors.tileFor("tile") else null

    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        Text(
            "Sponsored",
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            color = Slash.TextPrimary,
            modifier = Modifier.padding(start = 4.dp, bottom = 12.dp)
        )

        if (tile == null) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Slash.GlassRaised, RoundedCornerShape(18.dp))
                    .border(1.dp, Slash.GlassEdge, RoundedCornerShape(18.dp))
                    .padding(18.dp)
            ) {
                Text(
                    "Nothing here right now.",
                    fontSize = 13.sp,
                    color = Slash.TextPrimary
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    "One placement, bought by the hour and exclusive for those hours. " +
                        "Adverts are fetched in batches and chosen on this device — showing " +
                        "one makes no request, so nobody learns that you saw it.",
                    fontSize = 11.sp,
                    color = Slash.TextMuted,
                    lineHeight = 16.sp
                )
            }
            return
        }

        // Counted when the tile that is actually shown changes, not on every
        // recomposition — this page recomposes for unrelated reasons.
        LaunchedEffect(tile.id) { app.sponsors.noteImpression(tile.id) }

        Column(
            Modifier
                .fillMaxWidth()
                .background(Slash.GlassRaised, RoundedCornerShape(18.dp))
                .border(1.dp, Slash.GlassEdge, RoundedCornerShape(18.dp))
                .clickable {
                    // https only, enforced by the shared acceptCreative before
                    // this tile ever reached the list.
                    app.sponsors.noteClick(tile.id)
                    val tab = tabs.activeTab
                    if (tab == null) tabs.newTab(tile.clickUrl) else tab.navigate(tile.clickUrl)
                }
        ) {
            tile.bitmap?.let { bitmap ->
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxWidth().height(160.dp)
                )
            }
            Column(Modifier.padding(16.dp)) {
                Text(
                    tile.headline,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    color = Slash.TextPrimary,
                    lineHeight = 20.sp
                )
                if (tile.body.isNotBlank()) {
                    Spacer(Modifier.height(5.dp))
                    Text(tile.body, fontSize = 12.sp, color = Slash.TextMuted, lineHeight = 17.sp)
                }
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .background(Slash.GlassHigh, RoundedCornerShape(4.dp))
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    ) {
                        Text("AD", fontSize = 9.sp, color = Slash.TextMuted, letterSpacing = 0.8.sp)
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(tile.sponsor, fontSize = 11.sp, color = Slash.TextMuted)
                }
            }
        }
    }
}

/**
 * Slash's own error page.
 *
 * Chromium's cannot say whether Slash Shield refused the request, which is the
 * whole point of having one. Retrying clears the error, which is what reattaches
 * the view.
 */
@Composable
fun ErrorPage(message: String, tab: BrowserTab) {
    Box(
        Modifier.fillMaxSize().background(Slash.GlassPage).padding(32.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Default.Warning, null, Modifier.size(32.dp), tint = Slash.Bad)
            Spacer(Modifier.height(16.dp))
            Text(
                "This page did not load",
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
                color = Slash.TextPrimary
            )
            Spacer(Modifier.height(6.dp))
            Text(message, fontSize = 13.sp, textAlign = TextAlign.Center, color = Slash.TextMuted)
            Spacer(Modifier.height(4.dp))
            Text(
                tab.url,
                fontSize = 11.sp,
                textAlign = TextAlign.Center,
                color = Slash.TextMuted,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            Spacer(Modifier.height(22.dp))
            Box(
                Modifier
                    .background(Slash.Accent, CircleShape)
                    .clickable {
                        tab.error = null
                        tab.webView?.reload() ?: tab.navigate(tab.url)
                    }
                    .padding(horizontal = 22.dp, vertical = 11.dp)
            ) {
                Text("Try again", fontSize = 13.sp, color = Slash.Surface)
            }
        }
    }
}

/** Kept for the shortcut cards elsewhere. */
@Composable
internal fun GlobeIcon(modifier: Modifier = Modifier) {
    Icon(Icons.Default.Language, null, modifier, tint = Slash.TextMuted)
}
