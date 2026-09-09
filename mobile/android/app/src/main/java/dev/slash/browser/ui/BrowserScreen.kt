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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import dev.slash.browser.SlashApp
import dev.slash.browser.browser.BrowserTab
import dev.slash.browser.browser.SlashWebViewClient
import dev.slash.browser.browser.TabManager
import dev.slash.browser.ui.panels.AdvertisePanelContent
import dev.slash.browser.ui.panels.BookmarksPanelContent
import dev.slash.browser.ui.panels.DownloadsPanelContent
import dev.slash.browser.ui.panels.HistoryPanelContent
import dev.slash.browser.ui.panels.Panel
import dev.slash.browser.ui.panels.RewardsPanelContent
import dev.slash.browser.ui.panels.SettingsPanelContent
import dev.slash.browser.ui.panels.SlashPanel

/**
 * The chrome, laid out for a phone.
 *
 * The desktop stacks workspace row → tab strip → toolbar. Reproducing that here
 * is what made the first Android build read as a PC application: three rows of
 * chrome above every page, and a strip of 168dp tab chips that stops being
 * usable somewhere around the sixth tab.
 *
 * A phone browser has **one** row at the top — the address — and a bar at the
 * bottom within reach of a thumb. Tabs are a count and a grid; the menu is a
 * sheet. Workspaces moved into the switcher, so they cost nothing while
 * browsing and are still one tap from where tabs are managed.
 *
 * Nothing was dropped in the move. Everything the three desktop rows reached is
 * still here, just at the end of a gesture a thumb can make.
 */
@Composable
fun BrowserScreen(tabs: TabManager, modifier: Modifier = Modifier) {
    val app = SlashApp.instance
    val active = tabs.activeTab

    var panel by remember { mutableStateOf(Panel.NONE) }
    var showTabs by remember { mutableStateOf(false) }
    var showMenu by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var clearing by remember { mutableStateOf(false) }

    Box(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().background(Slash.GlassPage)) {

            Omnibar(
                tabs = tabs,
                editing = editing,
                onEditingChange = { editing = it },
                coreError = app.coreError
            )

            Box(Modifier.weight(1f).fillMaxWidth().background(Slash.GlassPage)) {
                if (active == null) {
                    StartPage(
                        tabs = tabs,
                        onOpenPanel = { panel = it },
                        onFocusOmnibox = { editing = true }
                    )
                } else {
                    key(active.id) {
                        PageHost(
                            tab = active,
                            tabs = tabs,
                            onOpenPanel = { panel = it },
                            onFocusOmnibox = { editing = true }
                        )
                    }
                }
                if (active != null && active.isLoading && active.progress in 1..99) {
                    Box(
                        Modifier
                            .fillMaxWidth(active.progress / 100f)
                            .height(2.dp)
                            .background(Slash.Accent)
                            .align(Alignment.TopStart)
                    )
                }
            }

            BottomBar(
                tabs = tabs,
                tabCount = tabs.visibleTabs.size,
                onTabs = {
                    // The visible tab has no thumbnail yet — it never stopped
                    // being visible. Taken here so the card you came from is not
                    // the one blank card in the grid.
                    tabs.activeTab?.captureThumbnail()
                    showTabs = true
                },
                onMenu = { showMenu = true }
            )
        }

        // Everything below is drawn after the page, so it composites above the
        // WebView. The desktop has the opposite problem — a CSS panel there
        // renders *underneath* the native page view, which is why it insets the
        // page rather than floating over it.

        if (showTabs) {
            TabSwitcher(
                tabs = tabs,
                onDismiss = { showTabs = false },
                onNewTab = {
                    tabs.newTab()
                    showTabs = false
                }
            )
        }

        if (showMenu) {
            MenuSheet(
                tabs = tabs,
                onDismiss = { showMenu = false },
                onOpenPanel = {
                    showMenu = false
                    panel = it
                },
                onClearData = {
                    showMenu = false
                    clearing = true
                }
            )
        }

        if (clearing) {
            ClearDataDialog(
                onDismiss = { clearing = false },
                onCleared = { clearing = false }
            )
        }

        val open = panel
        SlashPanel(
            open = open != Panel.NONE,
            title = when (open) {
                Panel.SETTINGS -> "Settings"
                Panel.HISTORY -> "History"
                Panel.BOOKMARKS -> "Bookmarks"
                Panel.REWARDS -> "Slash Coin"
                Panel.ADVERTISE -> "Advertise"
                Panel.DOWNLOADS -> "Downloads"
                Panel.NONE -> ""
            },
            onClose = { panel = Panel.NONE }
        ) {
            when (open) {
                Panel.SETTINGS -> SettingsPanelContent(
                    onOpenUrl = { url ->
                        panel = Panel.NONE
                        tabs.newTab(url)
                    },
                    onOpenRewards = { panel = Panel.REWARDS },
                    onOpenAdvertise = { panel = Panel.ADVERTISE }
                )
                Panel.HISTORY -> HistoryPanelContent { url ->
                    panel = Panel.NONE
                    tabs.activeTab?.navigate(url) ?: tabs.newTab(url)
                }
                Panel.BOOKMARKS -> BookmarksPanelContent { url ->
                    panel = Panel.NONE
                    tabs.activeTab?.navigate(url) ?: tabs.newTab(url)
                }
                Panel.REWARDS -> RewardsPanelContent { url ->
                    panel = Panel.NONE
                    tabs.newTab(url)
                }
                Panel.ADVERTISE -> AdvertisePanelContent { url ->
                    panel = Panel.NONE
                    tabs.newTab(url)
                }
                Panel.DOWNLOADS -> DownloadsPanelContent()
                Panel.NONE -> Unit
            }
        }
    }
}

/**
 * The address row — the only chrome above the page.
 *
 * A pill, and the host alone when it is not being edited. A phone has no room
 * for a full URL and showing one truncated in the middle tells nobody anything;
 * the host is the part that answers "where am I".
 */
@Composable
private fun Omnibar(
    tabs: TabManager,
    editing: Boolean,
    onEditingChange: (Boolean) -> Unit,
    coreError: String?
) {
    val tab = tabs.activeTab
    /**
     * The draft, as a `TextFieldValue` so the **selection** can be set.
     *
     * A plain `String` cannot say where the cursor is, and Compose put it at
     * offset 0 — so tapping the bar left the caret before the address, backspace
     * deleted nothing (there is nothing to the left of position 0), and typing
     * *prepended*. Measured: typing "github.com" into a bar holding a Google
     * result URL produced `github.comhttps://www.google.com/search?q=…`, which
     * is not a host, so it was searched for. That is the whole of "I cleared it
     * and searched something else and it searched the old thing".
     *
     * Keyed to the tab as well, so a draft never crosses into the next one.
     */
    var field by remember(tab?.id) { mutableStateOf(TextFieldValue("")) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    fun go(raw: String) {
        if (raw.isBlank()) return
        val target = Omnibox.resolve(raw, SlashApp.instance.settings.current.searchEngine)
        onEditingChange(false)
        keyboard?.hide()
        field = TextFieldValue("")
        val current = tabs.activeTab
        if (current == null) tabs.newTab(target) else current.navigate(target)
    }

    // Focus only. The seed happens synchronously where editing is turned on.
    //
    // Seeding here was a race, and it is the "I cleared it and typed something
    // else and it searched the old thing" bug: `LaunchedEffect` runs on the next
    // frame, so anything typed before it landed was overwritten by the address
    // it then wrote in. Typing fast enough — or an automated tap-and-type — beat
    // it every time, and the browser navigated to whatever had been there
    // before.
    LaunchedEffect(editing) {
        if (editing) {
            focus.requestFocus()
            keyboard?.show()
        }
    }

    Column(Modifier.fillMaxWidth().background(Slash.GlassBase)) {
        if (coreError != null) {
            Text(
                coreError,
                fontSize = 11.sp,
                color = Slash.Warn,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)
            )
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                Modifier
                    .weight(1f)
                    .background(if (editing) Slash.GlassHigh else Slash.GlassRaised, CircleShape)
                    .border(
                        1.dp,
                        if (editing) Slash.Accent else Slash.GlassEdge,
                        CircleShape
                    )
                    .clickable(enabled = !editing) {
                        // Seeded synchronously, and **selected**, which is what
                        // every browser does: the address is there to edit if
                        // you want it, and typing replaces it if you do not.
                        val seed = tab?.url?.takeIf { it != TabManager.HOME_URL }.orEmpty()
                        field = TextFieldValue(seed, selection = TextRange(0, seed.length))
                        onEditingChange(true)
                    }
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (editing) {
                    BasicTextField(
                        value = field,
                        onValueChange = { field = it },
                        singleLine = true,
                        textStyle = TextStyle(fontSize = 15.sp, color = Slash.TextPrimary),
                        cursorBrush = SolidColor(Slash.Accent),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                        keyboardActions = KeyboardActions(onGo = { go(field.text) }),
                        modifier = Modifier.weight(1f).focusRequester(focus)
                    )
                    Spacer(Modifier.width(8.dp))
                    // Clears the field rather than closing it, so a bar holding
                    // a long address can be emptied without fighting a caret.
                    // Closing is the second tap, once it is already empty.
                    Icon(
                        Icons.Default.Close,
                        if (field.text.isEmpty()) "Cancel" else "Clear",
                        Modifier.size(16.dp).clickable {
                            if (field.text.isEmpty()) {
                                onEditingChange(false)
                                keyboard?.hide()
                            } else {
                                field = TextFieldValue("")
                            }
                        },
                        tint = Slash.TextMuted
                    )
                } else {
                    val url = tab?.url.orEmpty()
                    val display = Omnibox.display(url)
                    when {
                        display.isEmpty() ->
                            Icon(Icons.Default.Search, null, Modifier.size(16.dp), tint = Slash.TextMuted)
                        Omnibox.isSecure(url) ->
                            Icon(Icons.Default.Lock, "Secure", Modifier.size(14.dp), tint = Slash.Good)
                        else -> Unit
                    }
                    Spacer(Modifier.width(9.dp))
                    Text(
                        display.ifEmpty { "Search or type a web address" },
                        fontSize = 15.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        color = if (display.isEmpty()) Slash.TextMuted else Slash.TextPrimary,
                        modifier = Modifier.weight(1f)
                    )
                    if ((tab?.blocked ?: 0) > 0) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Shield, "Blocked", Modifier.size(13.dp), tint = Slash.Accent)
                            Text(
                                " ${tab?.blocked}",
                                fontSize = 11.sp,
                                color = Slash.Accent
                            )
                        }
                        Spacer(Modifier.width(8.dp))
                    }
                    Icon(
                        Icons.Default.Refresh,
                        "Reload",
                        Modifier.size(16.dp).clickable { tab?.webView?.reload() },
                        tint = Slash.TextMuted
                    )
                }
            }
        }
    }
}

@Composable
private fun PageHost(
    tab: BrowserTab,
    tabs: TabManager,
    onOpenPanel: (Panel) -> Unit,
    onFocusOmnibox: () -> Unit
) {
    val error = tab.error
    when {
        error != null -> ErrorPage(error, tab)
        tab.url == TabManager.HOME_URL -> StartPage(tabs, onOpenPanel, onFocusOmnibox)
        else -> AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                tab.ensureView(context) { owner ->
                    SlashWebViewClient(
                        tab = owner,
                        shield = SlashApp.instance.shield,
                        onPageUrlChanged = {},
                        onOpenInNewTab = { }
                    )
                }
            },
            update = { view ->
                // A navigation asked for by the shell — a shortcut, the omnibox
                // — is queued rather than loaded directly, because the WebView
                // may not exist yet. Without this the address changed and the
                // page did not.
                tab.takePendingUrl()?.let { view.loadUrl(it) }
            }
        )
    }
}
