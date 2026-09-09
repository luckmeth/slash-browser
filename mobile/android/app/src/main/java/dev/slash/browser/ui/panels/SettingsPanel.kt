package dev.slash.browser.ui.panels

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.slash.browser.SlashApp
import dev.slash.browser.ui.Slash
import kotlinx.coroutines.launch

/**
 * Settings.
 *
 * Only what the Android shell can actually honour is listed. A screen offering
 * 136 switches where twenty do something would be exactly the failure CLAUDE.md
 * calls out: a control with nothing behind it is an unfinished feature, not a
 * placeholder.
 *
 * Every hint says what the setting *costs*, not what it is called again.
 */
@Composable
fun SettingsPanelContent(
    onOpenUrl: (String) -> Unit = {},
    onOpenRewards: () -> Unit = {},
    onOpenAdvertise: () -> Unit = {}
) {
    val app = SlashApp.instance
    val settings = app.settings
    val current = settings.current
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {

        SettingsGroup("Slash Shield") {
            Toggle(
                "Block ads",
                "Uses the bundled starter list — the large advertising networks, not EasyList. " +
                    "${app.shield.ruleCount} rules loaded.",
                current.blockAds
            ) { on -> settings.update { it.copy(blockAds = on) } }
            RowDivider()
            Toggle(
                "Block trackers",
                "Analytics and cross-site measurement hosts.",
                current.blockTrackers
            ) { on -> settings.update { it.copy(blockTrackers = on) } }
            RowDivider()
            Toggle(
                "Strip YouTube ad fields",
                "Removes the ad fields from YouTube's player data before the page reads them. " +
                    "Adverts stitched into the video stream itself still get through — no " +
                    "filter can remove those, and this setting does not claim to. " +
                    "Applies to tabs opened after the change.",
                current.blockYouTubeVideoAds
            ) { on -> settings.update { it.copy(blockYouTubeVideoAds = on) } }
            RowDivider()
            Toggle(
                "Defuse pop-ups",
                "Lets a page's own window.open return harmlessly instead of throwing, so the " +
                    "click that asked for it still works. The pop-up still never opens. " +
                    "Applies to tabs opened after the change.",
                current.defusePopups
            ) { on -> settings.update { it.copy(defusePopups = on) } }
            RowDivider()
            Toggle(
                "Restore long-press menus",
                "Some sites cancel the long-press menu so you cannot copy a link or save an " +
                    "image. This stops them — at the cost of losing a site's own menu where it " +
                    "had a genuinely useful one. Applies to tabs opened after the change.",
                current.restoreContextMenu
            ) { on -> settings.update { it.copy(restoreContextMenu = on) } }
        }

        SettingsGroup("Browsing") {
            ActionRow(
                "Search engine",
                "Where a typed phrase goes when it is not an address.",
                value = current.searchEngine.replaceFirstChar(Char::uppercase)
            ) {
                val next = when (current.searchEngine) {
                    "duckduckgo" -> "google"
                    "google" -> "bing"
                    else -> "duckduckgo"
                }
                settings.update { it.copy(searchEngine = next) }
            }
            RowDivider()
            ActionRow(
                "Tabs kept loaded",
                "Android runs every tab in one shared renderer, and the system kills it under " +
                    "pressure. Past this many, the least recently used tab is put to sleep — it " +
                    "keeps its address and history, and reloads when you return to it.",
                value = current.maxLiveTabs.toString()
            ) {
                val next = if (current.maxLiveTabs >= 8) 2 else current.maxLiveTabs + 2
                settings.update { it.copy(maxLiveTabs = next) }
            }
        }

        SettingsGroup("Privacy") {
            Toggle(
                "Record history",
                "Kept on this device only, unless you turn on history sync below.",
                current.recordHistory
            ) { on -> settings.update { it.copy(recordHistory = on) } }
            RowDivider()
            Toggle(
                "Clear history when Slash closes",
                "Applies on next launch.",
                current.clearHistoryOnExit
            ) { on -> settings.update { it.copy(clearHistoryOnExit = on) } }
        }

        SyncSection()

        SettingsGroup("Sponsored tiles") {
            // No switch. Sponsored placements are what pays for Slash, and a
            // browser that lets its only revenue be switched off is not funded
            // — it is a hobby with a billing address.
            //
            // What is *not* traded away is the privacy shape: no identifier is
            // sent, nothing about browsing goes with the fetch, and images are
            // embedded so showing a tile makes no request at all. Being unable
            // to turn adverts off is a normal cost of a free product; being
            // tracked by them is not, and that part stays refused.
            Column(Modifier.fillMaxWidth().padding(14.dp)) {
                Text("One sponsored placement", fontSize = 14.sp, color = Slash.TextPrimary)
                Spacer(Modifier.height(3.dp))
                Text(
                    "Slash is free because of it, so it is always on. Adverts are fetched in " +
                        "batches every few hours and chosen on this device: the fetch carries " +
                        "no identifier and nothing about your browsing, images are embedded " +
                        "rather than loaded from a sponsor's server, and only a daily count of " +
                        "views and clicks is ever reported. Nobody learns that it was you.",
                    fontSize = 11.sp,
                    color = Slash.TextMuted,
                    lineHeight = 15.sp
                )
            }
            RowDivider()
            ActionRow(
                "Advertise in Slash",
                "What the placement is, what it costs, and what is deliberately not measured.",
                value = "Open"
            ) { onOpenAdvertise() }
            RowDivider()
            ActionRow(
                "Sponsor endpoint",
                if (current.sponsorEndpoint.isBlank()) {
                    "Not set, so nothing is ever requested and no tile appears."
                } else {
                    current.sponsorEndpoint
                },
                value = if (app.sponsors.tiles.isEmpty()) "none" else "${app.sponsors.tiles.size}"
            ) { }
        }

        SettingsGroup("Updates") {
            ActionRow(
                "Version",
                if (app.updates.available != null) {
                    "Version ${app.updates.available?.version} is available."
                } else {
                    app.updates.status ?: "Tap to check for a new version."
                },
                value = if (app.updates.checking) "…" else app.updates.currentVersion
            ) {
                scope.launch {
                    val info = app.updates.check(current.updateFeedUrl).getOrNull()
                    if (info != null) {
                        app.updates.download(info).getOrNull()?.let { app.updates.install(it) }
                    }
                }
            }
            RowDivider()
            Column(Modifier.fillMaxWidth().padding(14.dp)) {
                Text("Update feed", fontSize = 14.sp, color = Slash.TextPrimary)
                Spacer(Modifier.height(3.dp))
                Text(
                    "Where releases are published. Empty means Slash never checks. " +
                        "Every package is verified against its published checksum before " +
                        "anything is installed, and Android asks before it installs.",
                    fontSize = 11.sp,
                    color = Slash.TextMuted,
                    lineHeight = 15.sp
                )
                Spacer(Modifier.height(8.dp))
                Field(current.updateFeedUrl, "https://…/latest.json") { value ->
                    settings.update { it.copy(updateFeedUrl = value) }
                }
            }
        }

        SettingsGroup("Slash Coin") {
            ActionRow(
                "Slash Coin",
                if (app.rewards.isSignedIn) {
                    "Signed in as ${app.rewards.accountLabel.ifBlank { "your account" }}. " +
                        "Your balance follows the account, not this device."
                } else {
                    "Earn while you browse. Balance, today's total and sign-in are on " +
                        "their own screen."
                },
                value = if (app.rewards.isSignedIn) formatBalance(app.rewards.state.balance) else "Open"
            ) { onOpenRewards() }
        }

        Spacer(Modifier.height(24.dp))
        Text(
            "Slash for Android · shield ${app.shield.ruleCount} rules · " +
                "${app.shield.blockedCount} blocked this session",
            fontSize = 11.sp,
            color = Slash.TextMuted,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp)
        )
        Spacer(Modifier.height(32.dp))
    }
}

/**
 * Sync, including the passphrase.
 *
 * The passphrase is a **separate step from signing in**, and the copy says why:
 * it is what keeps the server unable to read anything, and it is the one thing
 * nobody can recover for you.
 */
@Composable
private fun SyncSection() {
    val app = SlashApp.instance
    val settings = app.settings
    val current = settings.current
    val scope = rememberCoroutineScope()

    var passphrase by remember { mutableStateOf("") }
    var endpoint by remember { mutableStateOf(current.syncEndpoint) }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    SettingsGroup("Sync") {
        Toggle(
            "Sync bookmarks and reading list",
            "Encrypted on this device before it is sent. The server stores ciphertext and a " +
                "timestamp — it cannot read any of it.",
            current.syncEnabled
        ) { on -> settings.update { it.copy(syncEnabled = on) } }
        RowDivider()
        Toggle(
            "Also sync history",
            "A separate switch on purpose: history is a different order of exposure from a " +
                "bookmark list. Addresses travel as keyed hashes the server cannot reverse, " +
                "and only the last 90 days, capped at 5,000 pages.",
            current.syncHistory,
            enabled = current.syncEnabled
        ) { on -> settings.update { it.copy(syncHistory = on) } }
        RowDivider()

        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Text("Sync server", fontSize = 14.sp, color = Slash.TextPrimary)
            Spacer(Modifier.height(3.dp))
            Text(
                "The address your other devices use. Empty means sync contacts nothing at all.",
                fontSize = 11.sp,
                color = Slash.TextMuted,
                lineHeight = 15.sp
            )
            Spacer(Modifier.height(8.dp))
            Field(endpoint, "https://…") {
                endpoint = it
                settings.update { s -> s.copy(syncEndpoint = it) }
            }
        }
        RowDivider()

        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Text(
                if (app.sync.isUnlocked) "Sync passphrase — unlocked" else "Sync passphrase",
                fontSize = 14.sp,
                color = if (app.sync.isUnlocked) Slash.Good else Slash.TextPrimary
            )
            Spacer(Modifier.height(3.dp))
            Text(
                "Never leaves this device, and is not your account password. It is what makes " +
                    "the encryption real rather than a promise — and it is why you type it once " +
                    "on each device. Forget it and the synced data is unrecoverable, because " +
                    "nobody holds a spare.",
                fontSize = 11.sp,
                color = Slash.TextMuted,
                lineHeight = 15.sp
            )
            Spacer(Modifier.height(8.dp))
            Field(passphrase, "Passphrase", secret = true) { passphrase = it }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(if (busy) "Working…" else "Unlock", enabled = !busy && passphrase.length >= 8) {
                    busy = true
                    message = null
                    scope.launch {
                        val result = app.sync.unlock(passphrase)
                        message = result.fold(
                            onSuccess = { "Unlocked. Sync is ready." },
                            onFailure = { it.message ?: "Could not unlock." }
                        )
                        passphrase = ""
                        busy = false
                    }
                }
                Spacer(Modifier.height(0.dp))
                if (app.sync.isUnlocked) {
                    Spacer(Modifier.height(0.dp))
                    Button("Sync now", enabled = !busy) {
                        busy = true
                        scope.launch {
                            val result = app.sync.syncNow()
                            message = result.fold(
                                onSuccess = { "Synced." },
                                onFailure = { it.message ?: "Sync failed." }
                            )
                            busy = false
                        }
                    }
                }
            }
            message?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, fontSize = 11.sp, color = Slash.TextMuted)
            }
        }
    }
}

@Composable
private fun Field(
    value: String,
    placeholder: String,
    secret: Boolean = false,
    onChange: (String) -> Unit
) {
    Box(
        Modifier
            .fillMaxWidth()
            .background(Slash.GlassHigh, RoundedCornerShape(8.dp))
            .border(1.dp, Slash.GlassEdge, RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 9.dp)
    ) {
        if (value.isEmpty()) {
            Text(placeholder, fontSize = 13.sp, color = Slash.TextMuted)
        }
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = TextStyle(fontSize = 13.sp, color = Slash.TextPrimary),
            cursorBrush = SolidColor(Slash.Accent),
            visualTransformation = if (secret) {
                PasswordVisualTransformation()
            } else {
                VisualTransformation.None
            },
            modifier = Modifier.fillMaxWidth()
        )
    }
}

@Composable
private fun Button(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier
            .padding(end = 8.dp)
            .background(
                if (enabled) Slash.GlassHigh else Slash.GlassHover,
                RoundedCornerShape(8.dp)
            )
            .border(1.dp, if (enabled) Slash.Accent else Slash.GlassEdge, RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp)
    ) {
        Text(label, fontSize = 13.sp, color = if (enabled) Slash.Accent else Slash.TextMuted)
    }
}


private fun formatBalance(value: Double): String =
    if (value >= 100) "%,.0f".format(value) else "%.2f".format(value)
