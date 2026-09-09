package dev.slash.browser

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import dev.slash.browser.browser.TabManager
import dev.slash.browser.ui.BrowserScreen
import dev.slash.browser.ui.SlashTheme
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            val app = SlashApp.instance
            val tabs = remember {
                TabManager(
                    onChanged = { app.noteTabsChanged() },
                    liveBudget = { app.settings.current.maxLiveTabs },
                    onPrivateEmptied = { app.clearPrivateData() }
                ).also { app.attachTabs(it) }
            }

            /**
             * The first tab waits for the shield rather than racing it — a tab
             * that starts loading before the rules arrive is a page whose
             * adverts were never filtered, which reads as "the blocker does not
             * work" and cannot be reproduced afterwards.
             *
             * Bounded, though. A shield that never arrives must not mean a
             * browser with no tabs: after the timeout the tab opens anyway, and
             * `coreError` is already on screen saying blocking is off.
             */
            LaunchedEffect(Unit) {
                withTimeoutOrNull(12_000) { app.shieldReady.await() }
                if (tabs.tabs.isNotEmpty()) return@LaunchedEffect

                val opened = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.dataString
                if (opened != null) {
                    tabs.newTab(opened)
                    return@LaunchedEffect
                }
                // A link click wins over the saved session: somebody who tapped
                // a link wants that link, not last night's tabs in front of it.
                val (saved, index) = if (app.settings.current.restoreTabsOnLaunch) {
                    app.session.load()
                } else {
                    emptyList<dev.slash.browser.browser.SavedTab>() to 0
                }
                if (saved.isNotEmpty()) tabs.restore(saved, index) else tabs.newTab()
            }

            // Periodic sync while the browser is open, at the configured
            // interval. Bound to the composition, so it stops with the screen
            // rather than running on in the background.
            LaunchedEffect(Unit) {
                while (isActive) {
                    delay(app.settings.current.syncIntervalMinutes.coerceIn(5, 1440) * 60_000L)
                    if (app.settings.current.syncEnabled && app.sync.isUnlocked) {
                        app.sync.syncNow()
                    }
                }
            }

            SlashTheme {
                val active = tabs.activeTab

                // Back goes back through the page's own history first, and only
                // leaves the app when there is nothing left to go back to —
                // which is what every browser does and what people expect.
                BackHandler(enabled = active?.canGoBack == true) {
                    active?.webView?.goBack()
                }

                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    // The chrome is inset out of the status and navigation bars
                    // by hand. Edge-to-edge is on so the page can paint behind
                    // them, but the toolbar and tab strip must not sit under the
                    // clock — which is exactly what the first build did.
                    BrowserScreen(
                        tabs = tabs,
                        modifier = Modifier
                            .fillMaxSize()
                            .background(MaterialTheme.colorScheme.background)
                            .windowInsetsPadding(WindowInsets.statusBars)
                            .windowInsetsPadding(WindowInsets.navigationBars)
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    /**
     * The earning clock.
     *
     * Driven from the lifecycle rather than a background service: coin accrues
     * only while Slash is actually in front of somebody, and "is this activity
     * resumed" is a fact Android already holds. A service that kept sampling
     * with the app in the background would be claiming time nobody spent here.
     *
     * The 30s cadence is `SAMPLE_INTERVAL_MS` from the shared rules, and the
     * loop is bound to the activity's scope, so it stops when the activity does
     * — there is no timer left running to leak or to keep earning.
     */
    override fun onResume() {
        super.onResume()
        val rewards = SlashApp.instance.rewards
        lifecycleScope.launch {
            while (isActive) {
                val earning = SlashApp.instance.settings.current.rewardsEnabled && rewards.isSignedIn
                rewards.sample(qualifying = earning)
                delay(30_000)
            }
        }
    }

    override fun onPause() {
        super.onPause()
        // Closes the open interval and flushes the outbox. Not fire-and-forget
        // on the activity scope, which is about to be cancelled — the
        // application scope outlives this.
        SlashApp.instance.onAppPaused()
    }
}
