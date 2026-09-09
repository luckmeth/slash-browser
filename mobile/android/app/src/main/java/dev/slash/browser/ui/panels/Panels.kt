package dev.slash.browser.ui.panels

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.slash.browser.ui.Slash

/** Which side panel is open, if any. Mirrors the desktop's `SidePanel`. */
enum class Panel { NONE, SETTINGS, HISTORY, BOOKMARKS, REWARDS, ADVERTISE, DOWNLOADS }

/**
 * The side panel.
 *
 * On desktop a CSS panel would render *underneath* the native page view, so the
 * desktop insets the page rather than floating over it. Android has the opposite
 * problem and the easier one: a Compose surface drawn after the `AndroidView`
 * in the same layout composites *above* it, so a panel can simply overlay the
 * page. No inset, no layout coordination, and no equivalent of
 * `ViewLayoutManager.setRightPanelWidth`.
 *
 * Full width on a phone, because a 320px rail beside a 400px page is not a
 * usable split — the desktop's side-by-side arrangement is a large-screen
 * affordance, not a design rule to carry over.
 */
@Composable
fun SlashPanel(
    open: Boolean,
    title: String,
    onClose: () -> Unit,
    actions: @Composable () -> Unit = {},
    content: @Composable () -> Unit
) {
    AnimatedVisibility(
        visible = open,
        enter = slideInHorizontally(initialOffsetX = { it }),
        exit = slideOutHorizontally(targetOffsetX = { it })
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .background(Slash.GlassPanel)
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Slash.GlassBase)
                    .padding(start = 16.dp, end = 6.dp, top = 10.dp, bottom = 10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    title,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Slash.TextPrimary,
                    modifier = Modifier.weight(1f)
                )
                actions()
                IconButton(onClick = onClose, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Default.Close, "Close", Modifier.size(18.dp), tint = Slash.TextMuted)
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(Slash.GlassEdge))
            Box(Modifier.weight(1f).fillMaxWidth()) { content() }
        }
    }
}

/** A settings group: one card, hairlines between rows. Follows `SettingsPanel.tsx`. */
@Composable
fun SettingsGroup(title: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp)) {
        Text(
            title.uppercase(),
            fontSize = 11.sp,
            letterSpacing = 1.2.sp,
            fontWeight = FontWeight.Medium,
            color = Slash.TextMuted,
            modifier = Modifier.padding(start = 2.dp, bottom = 8.dp)
        )
        Column(
            Modifier
                .fillMaxWidth()
                .background(Slash.GlassRaised, RoundedCornerShape(12.dp))
                .border(1.dp, Slash.GlassEdge, RoundedCornerShape(12.dp))
        ) {
            content()
        }
    }
}

/**
 * One switch row: **label left, control right**.
 *
 * The desktop moved to this arrangement after its settings screen became hard
 * to use precisely because it was thorough — the control sat ahead of the text,
 * so it landed in a different place on every row and there was no column to run
 * an eye down. The explanation goes underneath in muted text rather than being
 * cut, because explaining what a setting costs is principle 7.
 */
@Composable
fun Toggle(
    label: String,
    hint: String,
    checked: Boolean,
    enabled: Boolean = true,
    onChange: (Boolean) -> Unit
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled) { onChange(!checked) }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.Top
    ) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(
                label,
                fontSize = 14.sp,
                color = if (enabled) Slash.TextPrimary else Slash.TextMuted.copy(alpha = 0.5f)
            )
            if (hint.isNotEmpty()) {
                Spacer(Modifier.height(3.dp))
                Text(hint, fontSize = 11.sp, color = Slash.TextMuted, lineHeight = 15.sp)
            }
        }
        SlashSwitch(checked = checked, enabled = enabled, onChange = onChange)
    }
}

/**
 * A switch drawn by hand rather than Material's.
 *
 * Material 3's Switch carries its own colour roles, a 52×32 footprint and a
 * thumb that grows on press — all correct for a Material app and all visibly
 * not this browser. This one is the accent on `--glass-high`, in the sizes the
 * rest of the chrome uses.
 */
@Composable
fun SlashSwitch(checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    val track = when {
        !enabled -> Slash.GlassHover
        checked -> Slash.Accent
        else -> Slash.GlassHigh
    }
    Box(
        Modifier
            .size(width = 40.dp, height = 24.dp)
            .background(track, RoundedCornerShape(12.dp))
            .clickable(enabled = enabled) { onChange(!checked) },
        contentAlignment = if (checked) Alignment.CenterEnd else Alignment.CenterStart
    ) {
        Box(
            Modifier
                .padding(horizontal = 3.dp)
                .size(18.dp)
                .background(
                    if (checked) Slash.Surface else Slash.TextMuted,
                    RoundedCornerShape(9.dp)
                )
        )
    }
}

/** A row that opens something rather than toggling it. */
@Composable
fun ActionRow(label: String, hint: String = "", value: String = "", onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(label, fontSize = 14.sp, color = Slash.TextPrimary)
            if (hint.isNotEmpty()) {
                Spacer(Modifier.height(3.dp))
                Text(hint, fontSize = 11.sp, color = Slash.TextMuted, lineHeight = 15.sp)
            }
        }
        if (value.isNotEmpty()) {
            Text(value, fontSize = 13.sp, color = Slash.Accent)
        }
    }
}

/** The hairline between rows inside a group. */
@Composable
fun RowDivider() {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = 14.dp)
            .height(1.dp)
            .background(Slash.GlassEdge)
    )
}

/** Shown where a panel has nothing to list. */
@Composable
fun EmptyState(message: String) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(
            message,
            fontSize = 13.sp,
            color = Slash.TextMuted,
            lineHeight = 19.sp
        )
    }
}

/** A left-aligned column with the panel's standard padding. */
@Composable
fun PanelColumn(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxHeight().fillMaxWidth(),
        verticalArrangement = Arrangement.Top
    ) { content() }
}

@Composable
fun PanelSpacerWidth(width: Int) = Spacer(Modifier.width(width.dp))
