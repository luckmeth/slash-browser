package dev.slash.browser.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.slash.browser.SlashApp

/**
 * How much history to forget.
 *
 * Ranges rather than a single button, because "clear my history" almost never
 * means all of it — it usually means the last hour. The first build wired the
 * menu entry straight to `clear()`, so one tap with no confirmation destroyed
 * everything, and there is no undo for that.
 *
 * The count is read *before* anything is deleted and shown on the button, so the
 * confirmation says what will actually go rather than asking in the abstract.
 */
enum class ClearRange(val label: String, val millis: Long?) {
    LAST_HOUR("Last hour", 60 * 60 * 1000L),
    LAST_DAY("Last 24 hours", 24 * 60 * 60 * 1000L),
    LAST_WEEK("Last 7 days", 7 * 24 * 60 * 60 * 1000L),
    LAST_MONTH("Last 4 weeks", 28 * 24 * 60 * 60 * 1000L),

    /** Null means no cutoff — everything, which is the one that needs care. */
    ALL_TIME("All time", null)
}

@Composable
fun ClearDataDialog(onDismiss: () -> Unit, onCleared: () -> Unit) {
    val app = SlashApp.instance
    var range by remember { mutableStateOf(ClearRange.LAST_HOUR) }

    val affected = remember(range) {
        val cutoff = range.millis
        if (cutoff == null) app.history.count()
        else app.history.countSince(System.currentTimeMillis() - cutoff)
    }

    Box(Modifier.fillMaxSize()) {
        Box(
            Modifier.fillMaxSize().background(Slash.Scrim).clickable(onClick = onDismiss)
        )

        Column(
            Modifier
                .align(Alignment.Center)
                .padding(24.dp)
                .fillMaxWidth()
                .background(Slash.GlassPanel, RoundedCornerShape(20.dp))
                .border(1.dp, Slash.GlassEdge, RoundedCornerShape(20.dp))
                .padding(20.dp)
        ) {
            Text(
                "Delete browsing data",
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = Slash.TextPrimary
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "Removes pages from this device's history. Bookmarks are not touched, and " +
                    "nothing is removed from any other device.",
                fontSize = 12.sp,
                color = Slash.TextMuted,
                lineHeight = 17.sp
            )

            Spacer(Modifier.height(18.dp))

            ClearRange.entries.forEach { option ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { range = option }
                        .padding(vertical = 11.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        Modifier
                            .size(18.dp)
                            .background(
                                if (range == option) Slash.Accent else Slash.GlassHigh,
                                CircleShape
                            ),
                        contentAlignment = Alignment.Center
                    ) {
                        if (range == option) {
                            Icon(
                                Icons.Default.Check,
                                null,
                                Modifier.size(12.dp),
                                tint = Slash.Surface
                            )
                        }
                    }
                    Spacer(Modifier.width(12.dp))
                    Text(option.label, fontSize = 14.sp, color = Slash.TextPrimary)
                }
            }

            Spacer(Modifier.height(14.dp))

            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    Modifier
                        .clickable(onClick = onDismiss)
                        .padding(horizontal = 16.dp, vertical = 10.dp)
                ) {
                    Text("Cancel", fontSize = 14.sp, color = Slash.TextMuted)
                }
                Spacer(Modifier.width(8.dp))
                Box(
                    Modifier
                        .background(
                            if (affected == 0) Slash.GlassHigh else Slash.Bad,
                            CircleShape
                        )
                        .clickable(enabled = affected > 0) {
                            val cutoff = range.millis
                            if (cutoff == null) {
                                app.history.clear()
                            } else {
                                app.history.clearSince(System.currentTimeMillis() - cutoff)
                            }
                            onCleared()
                        }
                        .padding(horizontal = 18.dp, vertical = 10.dp)
                ) {
                    Text(
                        // Says what will go, counted before anything is deleted.
                        when (affected) {
                            0 -> "Nothing to delete"
                            1 -> "Delete 1 page"
                            else -> "Delete $affected pages"
                        },
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        color = if (affected == 0) Slash.TextMuted else Slash.TextPrimary
                    )
                }
            }
        }
    }
}
