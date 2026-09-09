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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.slash.browser.ui.Slash

/**
 * The advertise page, following `AdvertisePage.tsx` — sized for a phone.
 *
 * The desktop page sells placements in a wide three-column layout with hover
 * previews. None of that survives a 400dp screen, so this is one column: what is
 * for sale, what it costs, and what is deliberately *not* measured.
 *
 * The one rule carried over exactly is the one about numbers. The desktop page
 * refuses to print an audience figure, because impressions arrive aggregated,
 * hours late, and only from browsers that were reopened — so any figure would be
 * a guess contradicting the honesty section further down its own page. Same
 * here: no reach, no "12,000 daily readers", and it says why.
 */
@Composable
fun AdvertisePanelContent(onOpenUrl: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {

        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 26.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                "Advertise in Slash",
                fontSize = 22.sp,
                fontWeight = FontWeight.SemiBold,
                color = Slash.TextPrimary,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "One placement on the start page. Bought by the hour, exclusive for the " +
                    "hours you buy, and reviewed by a person before it runs.",
                fontSize = 12.sp,
                color = Slash.TextMuted,
                textAlign = TextAlign.Center,
                lineHeight = 18.sp
            )
        }

        SettingsGroup("What you get") {
            Point(
                "Exclusive for the hours you buy",
                "Not a share of an auction. The slot is yours for that window, and nobody " +
                    "else's creative appears in it."
            )
            RowDivider()
            Point(
                "Reviewed by a person",
                "Every creative is looked at before it runs. Images must be embedded and " +
                    "click targets must be https — enforced in the browser, not promised."
            )
            RowDivider()
            Point(
                "Nothing collected about who saw it",
                "No identifier travels with the fetch and no request is made when a tile is " +
                    "shown. You get a daily count of impressions and clicks, and that is " +
                    "genuinely all that exists."
            )
        }

        SettingsGroup("What is not measured") {
            Column(Modifier.fillMaxWidth().padding(14.dp)) {
                Text(
                    "No audience figure is published.",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = Slash.TextPrimary
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    "Counts arrive aggregated, hours late, and only from browsers that were " +
                        "reopened — so any \"daily readers\" number would be a guess. Hours are " +
                        "exact and placements are exclusive; those are the things worth buying " +
                        "on, and they are the things that can be stated truthfully.",
                    fontSize = 11.sp,
                    color = Slash.TextMuted,
                    lineHeight = 16.sp
                )
            }
        }

        SettingsGroup("Placements") {
            Placement("Tile", "A card among the start page shortcuts.")
            RowDivider()
            Placement("Banner", "Full width, above the shortcuts.")
            RowDivider()
            Placement("Background", "The start page's backdrop, behind everything else.")
        }

        Box(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp)
        ) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(Slash.GlassHigh, RoundedCornerShape(10.dp))
                    .border(1.dp, Slash.Accent, RoundedCornerShape(10.dp))
                    .clickable { onOpenUrl(PORTAL_URL) }
                    .padding(vertical = 13.dp),
                contentAlignment = Alignment.Center
            ) {
                Text("Open the advertiser portal", fontSize = 13.sp, color = Slash.Accent)
            }
        }

        Text(
            "Rates and availability are on the portal, which is where a campaign is booked. " +
                "It opens in a Slash tab.",
            fontSize = 11.sp,
            color = Slash.TextMuted,
            lineHeight = 16.sp,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 4.dp)
        )
        Spacer(Modifier.height(32.dp))
    }
}

@Composable
private fun Point(title: String, body: String) {
    Column(Modifier.fillMaxWidth().padding(14.dp)) {
        Text(title, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = Slash.TextPrimary)
        Spacer(Modifier.height(4.dp))
        Text(body, fontSize = 11.sp, color = Slash.TextMuted, lineHeight = 16.sp)
    }
}

@Composable
private fun Placement(name: String, where: String) {
    Row(
        Modifier.fillMaxWidth().padding(14.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.padding(end = 12.dp)) {
            Text(name, fontSize = 13.sp, color = Slash.TextPrimary)
            Spacer(Modifier.height(3.dp))
            Text(where, fontSize = 11.sp, color = Slash.TextMuted)
        }
    }
}

/**
 * The advertiser portal.
 *
 * Deliberately a link rather than a form: taking payment details inside a
 * browser panel would mean this app handling them, and the portal already does
 * that properly.
 */
private const val PORTAL_URL = "https://slashbrowser.com/advertise"
