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
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Language
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.slash.browser.browser.BrowserTab
import dev.slash.browser.browser.TabManager

/**
 * The tab switcher.
 *
 * This is what replaces the desktop's tab strip, and it is the single biggest
 * reason the first build felt like a PC application: a phone browser has no
 * permanent strip. It has a *count*, and a screen you open to see them all —
 * which costs no height while browsing and does not become unreadable at twenty
 * tabs the way a row of 168dp chips does.
 *
 * Workspaces live here too, for the same reason. On the desktop they are a row
 * across the top of every window; here they are chips at the top of the screen
 * you already opened to change tabs, so they cost nothing on the browsing path.
 *
 * Cards carry a thumbnail taken when the tab stopped being the visible one —
 * not a live preview, which would mean drawing every tab continuously. A tab
 * that has never been shown, or was restored from a previous session, has no
 * picture yet and falls back to its host; that is honest about what the browser
 * actually holds rather than a grey rectangle pretending to be a page.
 */
@Composable
fun TabSwitcher(
    tabs: TabManager,
    onDismiss: () -> Unit,
    onNewTab: () -> Unit
) {
    val visible = tabs.visibleTabs

    Column(Modifier.fillMaxSize().background(Slash.GlassPage)) {

        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                if (visible.size == 1) "1 tab" else "${visible.size} tabs",
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = Slash.TextPrimary,
                modifier = Modifier.weight(1f)
            )
            IconButton(onNewTab, Modifier.size(42.dp)) {
                Icon(Icons.Default.Add, "New tab", Modifier.size(22.dp), tint = Slash.TextPrimary)
            }
            IconButton(onDismiss, Modifier.size(42.dp)) {
                Icon(Icons.Default.Close, "Close", Modifier.size(20.dp), tint = Slash.TextMuted)
            }
        }

        // Workspace chips. Each is a separate WebView profile with its own
        // cookie jar — switching is not a filter, it is a different browser
        // session, and the copy under the chips says so once rather than in a
        // tooltip nobody opens on a phone.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            tabs.workspaces.forEach { workspace ->
                val selected = workspace.id == tabs.activeWorkspaceId
                val count = tabs.tabs.count { it.workspaceId == workspace.id }
                Box(
                    Modifier
                        .background(
                            if (selected) Slash.Accent else Slash.GlassRaised,
                            CircleShape
                        )
                        .clickable { tabs.switchWorkspace(workspace.id) }
                        .padding(horizontal = 14.dp, vertical = 7.dp)
                ) {
                    Text(
                        "${workspace.name}  $count",
                        fontSize = 12.sp,
                        color = if (selected) Slash.Surface else Slash.TextMuted
                    )
                }
            }
        }
        Text(
            if (tabs.isPrivate) {
                "Private: no history is kept, and closing the last private tab deletes " +
                    "its cookies and sign-ins. Downloads and bookmarks you make are kept."
            } else {
                "Workspaces keep separate cookies and sign-ins."
            },
            fontSize = 10.sp,
            color = if (tabs.isPrivate) Slash.Accent else Slash.TextMuted,
            lineHeight = 14.sp,
            modifier = Modifier.padding(start = 18.dp, end = 18.dp, top = 4.dp, bottom = 8.dp)
        )

        LazyVerticalGrid(
            columns = GridCells.Fixed(2),
            contentPadding = PaddingValues(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.weight(1f)
        ) {
            items(visible, key = { it.id }) { tab ->
                TabCard(
                    tab = tab,
                    selected = tab.id == tabs.activeTabId,
                    onOpen = {
                        tabs.select(tab.id)
                        onDismiss()
                    },
                    onClose = { tabs.close(tab.id) }
                )
            }
        }
    }
}

@Composable
private fun TabCard(
    tab: BrowserTab,
    selected: Boolean,
    onOpen: () -> Unit,
    onClose: () -> Unit
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Slash.GlassRaised, RoundedCornerShape(14.dp))
            .border(
                if (selected) 2.dp else 1.dp,
                if (selected) Slash.Accent else Slash.GlassEdge,
                RoundedCornerShape(14.dp)
            )
            .clickable(onClick = onOpen)
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 10.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icons.Default.Language, null, Modifier.size(14.dp), tint = Slash.TextMuted)
            Spacer(Modifier.width(8.dp))
            Text(
                tab.title.ifBlank { "New tab" },
                fontSize = 12.sp,
                color = Slash.TextPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            Box(
                Modifier.size(28.dp).clickable(onClick = onClose),
                contentAlignment = Alignment.Center
            ) {
                Icon(Icons.Default.Close, "Close tab", Modifier.size(14.dp), tint = Slash.TextMuted)
            }
        }

        // Where Chrome draws a thumbnail. Slash keeps at most four renderers
        // alive, so most cards genuinely have no pixels to show — a host and a
        // sleep marker is what the browser actually knows.
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(0.95f)
                .padding(horizontal = 10.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(Slash.GlassHigh),
            contentAlignment = Alignment.Center
        ) {
            val shot = tab.thumbnail
            if (shot != null) {
                // Captured when this tab stopped being the visible one. Aligned
                // to the top, because the top of a page is what identifies it —
                // centring a tall screenshot shows the middle of an article.
                Image(
                    bitmap = shot.asImageBitmap(),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    alignment = Alignment.TopCenter,
                    modifier = Modifier.fillMaxSize()
                )
                if (tab.isHibernated) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(Slash.Scrim)
                    )
                    Text("asleep", fontSize = 10.sp, color = Slash.TextPrimary)
                }
            } else {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        hostOf(tab.url),
                        fontSize = 11.sp,
                        color = Slash.TextMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(horizontal = 10.dp)
                    )
                    if (tab.isHibernated) {
                        Spacer(Modifier.height(6.dp))
                        Text("asleep", fontSize = 10.sp, color = Slash.TextMuted)
                    }
                }
            }
        }
        Spacer(Modifier.height(10.dp))
    }
}

private fun hostOf(url: String): String {
    if (url == TabManager.HOME_URL) return "Start page"
    return runCatching {
        java.net.URI(url).host?.removePrefix("www.") ?: url
    }.getOrDefault(url)
}
