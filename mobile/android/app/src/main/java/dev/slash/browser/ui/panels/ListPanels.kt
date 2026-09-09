package dev.slash.browser.ui.panels

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.slash.browser.SlashApp
import dev.slash.browser.ui.Slash
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * History.
 *
 * Search filters in SQL rather than in Kotlin: the table is the largest thing
 * the browser holds, and pulling every row into memory to filter it would make
 * opening this panel cost more the longer somebody has used the browser.
 */
@Composable
fun HistoryPanelContent(onOpen: (String) -> Unit) {
    val app = SlashApp.instance
    var query by remember { mutableStateOf("") }
    var version by remember { mutableStateOf(0) }
    val entries = remember(query, version) { app.history.recent(query = query) }

    Column(Modifier.fillMaxWidth()) {
        SearchField(query, "Search history") { query = it }

        if (entries.isEmpty()) {
            EmptyState(
                if (query.isBlank()) {
                    "Nothing here yet. Pages you visit will appear as you browse."
                } else {
                    "No pages match \"$query\"."
                }
            )
        } else {
            LazyColumn(Modifier.fillMaxWidth()) {
                items(entries, key = { it.url }) { entry ->
                    ListRow(
                        title = entry.title.ifBlank { entry.url },
                        subtitle = "${hostOf(entry.url)} · ${relativeTime(entry.lastVisitedAt)}",
                        onClick = { onOpen(entry.url) },
                        onDelete = {
                            app.history.delete(entry.url)
                            version += 1
                        }
                    )
                }
            }
        }
    }
}

/** Bookmarks. Deleting one writes a tombstone first, so the removal can sync. */
@Composable
fun BookmarksPanelContent(onOpen: (String) -> Unit) {
    val app = SlashApp.instance
    var version by remember { mutableStateOf(0) }
    val items = remember(version) { app.bookmarks.all().filter { !it.isFolder } }

    if (items.isEmpty()) {
        EmptyState("No bookmarks yet. Use the star in the toolbar to save a page.")
        return
    }

    LazyColumn(Modifier.fillMaxWidth()) {
        items(items, key = { it.guid }) { bookmark ->
            ListRow(
                title = bookmark.title.ifBlank { bookmark.url.orEmpty() },
                subtitle = hostOf(bookmark.url.orEmpty()),
                onClick = { bookmark.url?.let(onOpen) },
                onDelete = {
                    app.bookmarks.remove(bookmark.guid)
                    version += 1
                }
            )
        }
    }
}

@Composable
private fun ListRow(
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    onDelete: () -> Unit
) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f).padding(end = 10.dp)) {
                Text(
                    title,
                    fontSize = 13.sp,
                    color = Slash.TextPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    subtitle,
                    fontSize = 11.sp,
                    color = Slash.TextMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Icon(
                Icons.Default.Delete,
                "Remove",
                Modifier.size(16.dp).clickable(onClick = onDelete),
                tint = Slash.TextMuted
            )
        }
        RowDivider()
    }
}

@Composable
private fun SearchField(value: String, placeholder: String, onChange: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(12.dp)
            .background(Slash.GlassHigh, RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(Icons.Default.Search, null, Modifier.size(14.dp), tint = Slash.TextMuted)
        Spacer(Modifier.size(8.dp))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) {
                Text(placeholder, fontSize = 13.sp, color = Slash.TextMuted)
            }
            BasicTextField(
                value = value,
                onValueChange = onChange,
                singleLine = true,
                textStyle = TextStyle(fontSize = 13.sp, color = Slash.TextPrimary),
                cursorBrush = SolidColor(Slash.Accent),
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

private fun hostOf(url: String): String =
    runCatching { java.net.URI(url).host?.removePrefix("www.") ?: url }.getOrDefault(url)

/**
 * "3 minutes ago", not a timestamp.
 *
 * A history list is read to find something you saw recently, and a wall-clock
 * time makes the reader do the subtraction.
 */
private fun relativeTime(millis: Long): String {
    val delta = System.currentTimeMillis() - millis
    val minutes = delta / 60_000
    val hours = minutes / 60
    val days = hours / 24
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "$minutes min ago"
        hours < 24 -> "$hours h ago"
        days < 7 -> "$days d ago"
        else -> SimpleDateFormat("d MMM yyyy", Locale.getDefault()).format(Date(millis))
    }
}
