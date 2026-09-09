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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.slash.browser.SlashApp
import dev.slash.browser.downloads.DownloadState
import dev.slash.browser.ui.Slash

/**
 * Downloads.
 *
 * Every row says where it came from. A transfer yt-dlp made is labelled **via
 * yt-dlp**, because a download the browser could not have made on its own must
 * never look like one it did — the same rule `adoptExternal` follows on the
 * desktop.
 */
@Composable
fun DownloadsPanelContent() {
    val app = SlashApp.instance
    val rows = app.downloads.downloads

    if (rows.isEmpty()) {
        EmptyState(
            "Nothing downloaded yet.\n\n" +
                "Open a video page and choose Download video from the menu, or long-press a " +
                "link to a file. Videos are fetched by yt-dlp, a separate program bundled with " +
                "Slash; DRM-protected streams cannot be downloaded by anything and are refused " +
                "with a reason rather than a broken file."
        )
        return
    }

    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "${rows.size} download${if (rows.size == 1) "" else "s"}",
                fontSize = 12.sp,
                color = Slash.TextMuted,
                modifier = Modifier.weight(1f)
            )
            Text(
                "Clear finished",
                fontSize = 12.sp,
                color = Slash.Accent,
                modifier = Modifier.clickable { app.downloads.clearFinished() }
            )
        }
        RowDivider()

        LazyColumn(Modifier.fillMaxWidth()) {
            items(rows, key = { it.id }) { row ->
                Column {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(Modifier.weight(1f).padding(end = 10.dp)) {
                            Text(
                                row.title,
                                fontSize = 13.sp,
                                color = Slash.TextPrimary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            Spacer(Modifier.height(3.dp))
                            Text(
                                row.detail,
                                fontSize = 11.sp,
                                color = when (row.state) {
                                    DownloadState.FAILED -> Slash.Bad
                                    DownloadState.COMPLETED -> Slash.Good
                                    else -> Slash.TextMuted
                                },
                                maxLines = 2,
                                lineHeight = 15.sp
                            )
                            if (row.viaYtDlp) {
                                Spacer(Modifier.height(4.dp))
                                Box(
                                    Modifier
                                        .background(Slash.GlassHigh, RoundedCornerShape(4.dp))
                                        .padding(horizontal = 6.dp, vertical = 2.dp)
                                ) {
                                    Text("via yt-dlp", fontSize = 9.sp, color = Slash.TextMuted)
                                }
                            }
                            if (row.state == DownloadState.RUNNING) {
                                Spacer(Modifier.height(7.dp))
                                Box(
                                    Modifier
                                        .fillMaxWidth()
                                        .height(3.dp)
                                        .background(Slash.GlassHigh, RoundedCornerShape(2.dp))
                                ) {
                                    Box(
                                        Modifier
                                            .fillMaxWidth(row.progress.coerceIn(0f, 1f))
                                            .height(3.dp)
                                            .background(Slash.Accent, RoundedCornerShape(2.dp))
                                    )
                                }
                            }
                        }
                        if (row.state == DownloadState.RUNNING ||
                            row.state == DownloadState.QUEUED
                        ) {
                            Icon(
                                Icons.Default.Close,
                                "Cancel",
                                Modifier.size(16.dp).clickable { app.downloads.cancel(row.id) },
                                tint = Slash.TextMuted
                            )
                        }
                    }
                    RowDivider()
                }
            }
        }
    }
}
