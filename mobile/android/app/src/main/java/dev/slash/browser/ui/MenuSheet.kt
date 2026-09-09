package dev.slash.browser.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.VideoLibrary
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.slash.browser.SlashApp
import dev.slash.browser.browser.TabManager
import dev.slash.browser.ui.panels.Panel

/**
 * The overflow menu, as a bottom sheet.
 *
 * Two halves, following the shape phone browsers settled on: a row of icon
 * destinations along the top, then the actions that apply to the page you are
 * on. A sheet rather than a side panel because it is reachable with a thumb and
 * dismissed by tapping away, and because the desktop's right-hand panel put
 * every entry at the far end of a phone screen.
 */
@Composable
fun MenuSheet(
    tabs: TabManager,
    onDismiss: () -> Unit,
    onOpenPanel: (Panel) -> Unit,
    onClearData: () -> Unit
) {
    val app = SlashApp.instance
    val tab = tabs.activeTab
    val bookmarked = tab?.url?.let { url -> app.bookmarks.findByUrl(url) != null } == true

    Box(Modifier.fillMaxSize()) {
        // The scrim. Tapping it dismisses, which is the gesture people try first.
        Box(
            Modifier
                .fillMaxSize()
                .background(Slash.Scrim)
                .clickable(onClick = onDismiss)
        )

        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(
                    Slash.GlassPanel,
                    RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)
                )
                .verticalScroll(rememberScrollState())
                .padding(bottom = 20.dp)
        ) {
            // Grab handle. Purely a signal that this is a sheet, which is what
            // tells somebody it can be swiped away.
            Box(
                Modifier
                    .padding(top = 10.dp, bottom = 14.dp)
                    .align(Alignment.CenterHorizontally)
                    .width(36.dp)
                    .height(4.dp)
                    .background(Slash.GlassEdgeStrong, RoundedCornerShape(2.dp))
            )

            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                MenuIcon(Icons.Default.History, "History") { onOpenPanel(Panel.HISTORY) }
                MenuIcon(Icons.Default.Bookmark, "Bookmarks") { onOpenPanel(Panel.BOOKMARKS) }
                MenuIcon(Icons.Default.Shield, "Slash Coin") { onOpenPanel(Panel.REWARDS) }
                MenuIcon(
                    Icons.Default.Download,
                    "Downloads",
                    badge = app.downloads.activeCount
                ) { onOpenPanel(Panel.DOWNLOADS) }
                MenuIcon(Icons.Default.Settings, "Settings") { onOpenPanel(Panel.SETTINGS) }
            }

            Spacer(Modifier.height(14.dp))
            Divider()

            MenuRow(Icons.Default.Refresh, "Reload", enabled = tab != null) {
                tab?.webView?.reload()
                onDismiss()
            }
            MenuRow(
                if (bookmarked) Icons.Default.Bookmark else Icons.Default.BookmarkBorder,
                if (bookmarked) "Bookmarked" else "Bookmark this page",
                enabled = tab != null && tab.url.startsWith("http")
            ) {
                val current = tab ?: return@MenuRow
                if (!bookmarked) app.bookmarks.add(current.url, current.title)
                onDismiss()
            }
            MenuRow(Icons.Default.Add, "New tab") {
                tabs.newTab()
                onDismiss()
            }

            Divider()

            MenuRow(
                Icons.Default.VideoLibrary,
                "Download video",
                enabled = tab != null && tab.url.startsWith("http")
            ) {
                val current = tab ?: return@MenuRow
                // Handed to yt-dlp, which decides whether this page has a video
                // at all — Slash does not guess from the address, and a page
                // with nothing to offer gets a sentence rather than a broken
                // file.
                app.downloads.startVideo(current.url, current.title)
                onDismiss()
                onOpenPanel(Panel.DOWNLOADS)
            }

            Divider()

            MenuRow(Icons.Default.DeleteSweep, "Delete browsing data") {
                // Opens the range picker. Wired straight to clear() before, one
                // tap destroyed every page ever visited with no confirmation
                // and no undo.
                onClearData()
            }
            MenuRow(Icons.Default.Campaign, "Advertise in Slash") { onOpenPanel(Panel.ADVERTISE) }
        }
    }
}

@Composable
private fun MenuIcon(
    icon: ImageVector,
    label: String,
    /**
     * A count drawn over the icon, or 0 for none.
     *
     * The menu is the only route to the Downloads panel on a phone, so without
     * this a transfer running in the background is invisible unless you go
     * looking for it — the same complaint the desktop answered with taskbar
     * progress.
     */
    badge: Int = 0,
    onClick: () -> Unit
) {
    Column(
        Modifier.width(76.dp).clickable(onClick = onClick).padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            Modifier.size(48.dp).background(Slash.GlassHigh, RoundedCornerShape(14.dp)),
            contentAlignment = Alignment.Center
        ) {
            Icon(icon, null, Modifier.size(22.dp), tint = Slash.Accent)
            if (badge > 0) {
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .padding(6.dp)
                        .background(Slash.Accent, RoundedCornerShape(7.dp))
                        .padding(horizontal = 4.dp, vertical = 1.dp)
                ) {
                    Text(
                        if (badge > 9) "9+" else badge.toString(),
                        fontSize = 9.sp,
                        color = Slash.Surface,
                        maxLines = 1
                    )
                }
            }
        }
        Spacer(Modifier.height(7.dp))
        Text(label, fontSize = 11.sp, color = Slash.TextMuted, maxLines = 1)
    }
}

@Composable
private fun MenuRow(
    icon: ImageVector,
    label: String,
    enabled: Boolean = true,
    onClick: () -> Unit
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 22.dp, vertical = 15.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            label,
            fontSize = 15.sp,
            color = if (enabled) Slash.TextPrimary else Slash.TextMuted.copy(alpha = 0.4f),
            modifier = Modifier.weight(1f)
        )
        Icon(
            icon,
            null,
            Modifier.size(20.dp),
            tint = if (enabled) Slash.TextMuted else Slash.TextMuted.copy(alpha = 0.4f)
        )
    }
}

@Composable
private fun Divider() {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .height(1.dp)
            .background(Slash.GlassEdge)
    )
}

/** The bottom navigation bar. Back, forward, home, tab count, menu. */
@Composable
fun BottomBar(
    tabs: TabManager,
    tabCount: Int,
    onTabs: () -> Unit,
    onMenu: () -> Unit
) {
    val tab = tabs.activeTab
    Row(
        Modifier
            .fillMaxWidth()
            .background(Slash.GlassBase)
            .padding(horizontal = 6.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceEvenly
    ) {
        BarButton(
            Icons.Default.ArrowBack,
            "Back",
            tab?.canGoBack == true
        ) { tab?.webView?.goBack() }

        BarButton(
            Icons.Default.ArrowForward,
            "Forward",
            tab?.canGoForward == true
        ) { tab?.webView?.goForward() }

        BarButton(Icons.Default.Home, "Start page", true) {
            tabs.activeTab?.navigate(TabManager.HOME_URL) ?: tabs.newTab()
        }

        // The tab count, which is what replaces a strip. A square with a number
        // in it is the convention, and it is legible at twenty tabs where a row
        // of chips is not.
        Box(
            Modifier
                .size(44.dp)
                .clickable(onClick = onTabs),
            contentAlignment = Alignment.Center
        ) {
            Box(
                Modifier
                    .size(22.dp)
                    .background(Slash.TextMuted, RoundedCornerShape(6.dp)),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    if (tabCount > 99) "99+" else tabCount.toString(),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Slash.GlassBase
                )
            }
        }

        BarButton(Icons.Default.MoreVert, "Menu", true, onMenu)
    }
}

@Composable
private fun BarButton(
    icon: ImageVector,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit
) {
    Box(
        Modifier.size(44.dp).clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Icon(
            icon,
            contentDescription = label,
            modifier = Modifier.size(22.dp),
            tint = if (enabled) Slash.TextPrimary else Slash.TextMuted.copy(alpha = 0.35f)
        )
    }
}
