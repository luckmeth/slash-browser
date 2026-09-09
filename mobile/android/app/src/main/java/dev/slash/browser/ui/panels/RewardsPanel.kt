package dev.slash.browser.ui.panels

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.slash.browser.SlashApp
import dev.slash.browser.ui.BrandMark
import dev.slash.browser.ui.Slash

/**
 * Slash Coin, following the desktop's `RewardsSection` and `RewardsPage`.
 *
 * Everything numeric here comes from the server. The client does not add up a
 * balance and show it — it reports closed intervals and displays what comes
 * back, because a balance the client owns is one a text editor could forge and
 * this is meant to become tradeable.
 *
 * Sized for a phone: one figure at the top rather than the desktop's three
 * across, the day's progress as a bar rather than a ring, and the explanation
 * below the fold instead of beside it.
 */
@Composable
fun RewardsPanelContent(onOpenUrl: (String) -> Unit) {
    val app = SlashApp.instance
    val rewards = app.rewards
    val settings = app.settings
    val state = rewards.state

    // Refreshed when the panel opens rather than on a timer: this screen is the
    // only thing that reads it, and polling a balance nobody is looking at is
    // exactly the kind of idle cost principle 1 refuses.
    LaunchedEffect(rewards.isSignedIn) {
        if (rewards.isSignedIn) {
            rewards.report()
        }
    }

    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {

        Column(
            Modifier.fillMaxWidth().padding(vertical = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            BrandMark(size = 34.dp, color = Slash.Accent)
            Spacer(Modifier.height(14.dp))
            if (rewards.isSignedIn) {
                Text(
                    formatCoins(state.balance),
                    fontSize = 34.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Slash.TextPrimary
                )
                Text("Slash Coin", fontSize = 12.sp, color = Slash.TextMuted)
                state.coinToUsd?.let { rate ->
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "≈ $${"%.2f".format(state.balance * rate)}",
                        fontSize = 11.sp,
                        color = Slash.TextMuted
                    )
                }
                // Absent means unpublished, and that has to survive to the
                // screen as absence rather than collapsing into "$0.00".
                if (state.coinToUsd == null) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "No exchange rate is published yet.",
                        fontSize = 11.sp,
                        color = Slash.TextMuted
                    )
                }
            } else {
                Text(
                    "Slash Coin",
                    fontSize = 22.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Slash.TextPrimary
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    "Earn while you browse. Your balance follows your account,\nnot this device.",
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    color = Slash.TextMuted,
                    lineHeight = 17.sp
                )
            }
        }

        if (rewards.isSignedIn) {
            SettingsGroup("Today") {
                Column(Modifier.fillMaxWidth().padding(14.dp)) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            formatSpan(state.secondsToday),
                            fontSize = 14.sp,
                            color = Slash.TextPrimary
                        )
                        Text(
                            "of ${formatSpan(state.dailyCapSeconds)}",
                            fontSize = 12.sp,
                            color = Slash.TextMuted
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    val fraction = if (state.dailyCapSeconds > 0) {
                        (state.secondsToday.toFloat() / state.dailyCapSeconds).coerceIn(0f, 1f)
                    } else 0f
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(6.dp)
                            .background(Slash.GlassHigh, RoundedCornerShape(3.dp))
                    ) {
                        Box(
                            Modifier
                                .fillMaxWidth(fraction)
                                .height(6.dp)
                                .background(Slash.Accent, RoundedCornerShape(3.dp))
                        )
                    }
                    if (state.coinsPerHour > 0) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "${formatCoins(state.coinsPerHour)} an hour while Slash is in front of you.",
                            fontSize = 11.sp,
                            color = Slash.TextMuted
                        )
                    }
                    if (rewards.pendingSeconds > 0) {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "${formatSpan(rewards.pendingSeconds)} waiting to be reported — " +
                                "kept on this device until it can be sent, so nothing is lost offline.",
                            fontSize = 11.sp,
                            color = Slash.TextMuted,
                            lineHeight = 15.sp
                        )
                    }
                }
            }
        }

        SettingsGroup("Earning") {
            Toggle(
                "Earn Slash Coin while browsing",
                "Time is credited only while Slash is in front of you and signed in. " +
                    "Nothing accrues in the background, and time across a gap the browser " +
                    "did not observe — a phone that was asleep — is never claimed.",
                settings.current.rewardsEnabled
            ) { on -> settings.update { it.copy(rewardsEnabled = on) } }
            RowDivider()
            ActionRow(
                if (rewards.isSignedIn) "Account" else "Sign in with Google",
                if (rewards.isSignedIn) {
                    rewards.accountLabel.ifBlank { "Signed in" }
                } else {
                    "The sign-in opens in a Slash tab, so it finishes in the same browser it " +
                        "started in. Slash never sees your password."
                },
                value = if (rewards.isSignedIn) "Sign out" else "Sign in"
            ) {
                if (rewards.isSignedIn) {
                    rewards.signOut()
                } else {
                    rewards.beginSignIn()?.let(onOpenUrl)
                }
            }
        }

        rewards.lastError?.let { error ->
            Text(
                error,
                fontSize = 11.sp,
                color = Slash.Warn,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 6.dp)
            )
        }

        Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp)) {
            Text(
                "How the count is kept honest",
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = Slash.TextPrimary
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "Slash reports closed stretches of time and never a total. The server decides " +
                    "what they are worth, and refuses stretches that overlap — so signing in on " +
                    "twenty devices earns the time of one, not twenty.",
                fontSize = 11.sp,
                color = Slash.TextMuted,
                lineHeight = 16.sp
            )
        }
        Spacer(Modifier.height(32.dp))
    }
}

private fun formatCoins(value: Double): String =
    if (value >= 100) "%,.0f".format(value) else "%.2f".format(value)

/** "1h 24m", because a raw second count is not a thing anybody reads. */
private fun formatSpan(seconds: Long): String {
    val hours = seconds / 3600
    val minutes = (seconds % 3600) / 60
    return when {
        hours > 0 && minutes > 0 -> "${hours}h ${minutes}m"
        hours > 0 -> "${hours}h"
        minutes > 0 -> "${minutes}m"
        else -> "${seconds}s"
    }
}
