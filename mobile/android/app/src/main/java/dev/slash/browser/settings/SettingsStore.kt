package dev.slash.browser.settings

import android.content.Context
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import org.json.JSONObject
import java.io.File

/**
 * Settings, mirroring the desktop's keys.
 *
 * Only the subset the Android shell can actually honour is here. That is
 * deliberate: CLAUDE.md treats a control with nothing behind it as an unfinished
 * feature, and a settings screen listing 136 switches where 20 do something
 * would be exactly that. Keys are spelled as the desktop spells them so the two
 * can be compared without translating.
 *
 * Stored as JSON beside the database rather than in SharedPreferences, for the
 * same reason the desktop keeps its profile list as plain JSON: it has to be
 * readable and writable without any other subsystem being up, including during
 * a failed start.
 */
class SettingsStore(context: Context) {

    private val file = File(context.filesDir, "settings.json")

    /**
     * Compose reads this, so a change repaints whatever depends on it. One
     * object rather than per-key state: a settings write is rare and the screen
     * that shows them all is the main reader.
     */
    var current by mutableStateOf(Settings())
        private set

    init {
        load()
    }

    private fun load() {
        if (!file.exists()) return
        current = runCatching { Settings.fromJson(JSONObject(file.readText())) }
            .getOrElse { Settings() }
    }

    /**
     * Applies a patch.
     *
     * Takes a lambda over the current value rather than a partial object,
     * because the desktop learned the hard way that a "partial" schema whose
     * fields carry defaults is not a patch: an absent key parses to its default
     * and silently resets every setting the caller did not mention. Turn two
     * switches on and the first comes back off. A copy() closure cannot express
     * that mistake.
     */
    fun update(transform: (Settings) -> Settings) {
        current = transform(current)
        runCatching { file.writeText(current.toJson().toString(2)) }
    }
}

data class Settings(
    // --- Shield ---
    val blockAds: Boolean = true,
    val blockTrackers: Boolean = true,
    val blockYouTubeVideoAds: Boolean = true,
    val defusePopups: Boolean = true,
    val restoreContextMenu: Boolean = false,

    // --- Browsing ---
    /**
     * Google, matching the desktop's `searchEngineId` default. The first
     * Android build shipped DuckDuckGo, which quietly made the same typed
     * phrase go to a different place depending on which device you were on.
     */
    val searchEngine: String = "google",
    val restoreTabsOnLaunch: Boolean = true,
    val maxLiveTabs: Int = 4,

    // --- Privacy ---
    val recordHistory: Boolean = true,
    val clearHistoryOnExit: Boolean = false,

    // --- Sync ---
    val syncEnabled: Boolean = false,
    val syncHistory: Boolean = false,
    val syncEndpoint: String = "",
    val syncToken: String = "",
    val syncIntervalMinutes: Int = 30,

    // --- Sponsored tiles ---
    // No enable flag. Sponsored placements fund Slash and are not optional; the
    // endpoint is the only thing configurable, so a build with none set still
    // contacts nothing. A boolean here would be a control with nothing behind
    // it, which this file has one rule against.
    val sponsorEndpoint: String = "",

    // --- Updates ---
    /** Where the release feed lives. Empty means Slash never checks. */
    val updateFeedUrl: String = "",
    val autoCheckUpdates: Boolean = true,

    // --- Rewards ---
    val rewardsEnabled: Boolean = false
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("blockAds", blockAds)
        put("blockTrackers", blockTrackers)
        put("blockYouTubeVideoAds", blockYouTubeVideoAds)
        put("defusePopups", defusePopups)
        put("restoreContextMenu", restoreContextMenu)
        put("searchEngine", searchEngine)
        put("restoreTabsOnLaunch", restoreTabsOnLaunch)
        put("maxLiveTabs", maxLiveTabs)
        put("recordHistory", recordHistory)
        put("clearHistoryOnExit", clearHistoryOnExit)
        put("syncEnabled", syncEnabled)
        put("syncHistory", syncHistory)
        put("syncEndpoint", syncEndpoint)
        put("syncToken", syncToken)
        put("syncIntervalMinutes", syncIntervalMinutes)
        put("sponsorEndpoint", sponsorEndpoint)
        put("updateFeedUrl", updateFeedUrl)
        put("autoCheckUpdates", autoCheckUpdates)
        put("rewardsEnabled", rewardsEnabled)
    }

    companion object {
        /**
         * Reads what is present and leaves the rest at its default.
         *
         * `optBoolean(key, default)` rather than `getBoolean` throughout, so a
         * settings file written by an older build — missing keys added since —
         * loads rather than throwing and resetting everything.
         */
        fun fromJson(json: JSONObject): Settings {
            val d = Settings()
            return Settings(
                blockAds = json.optBoolean("blockAds", d.blockAds),
                blockTrackers = json.optBoolean("blockTrackers", d.blockTrackers),
                blockYouTubeVideoAds = json.optBoolean("blockYouTubeVideoAds", d.blockYouTubeVideoAds),
                defusePopups = json.optBoolean("defusePopups", d.defusePopups),
                restoreContextMenu = json.optBoolean("restoreContextMenu", d.restoreContextMenu),
                searchEngine = json.optString("searchEngine", d.searchEngine),
                restoreTabsOnLaunch = json.optBoolean("restoreTabsOnLaunch", d.restoreTabsOnLaunch),
                maxLiveTabs = json.optInt("maxLiveTabs", d.maxLiveTabs),
                recordHistory = json.optBoolean("recordHistory", d.recordHistory),
                clearHistoryOnExit = json.optBoolean("clearHistoryOnExit", d.clearHistoryOnExit),
                syncEnabled = json.optBoolean("syncEnabled", d.syncEnabled),
                syncHistory = json.optBoolean("syncHistory", d.syncHistory),
                syncEndpoint = json.optString("syncEndpoint", d.syncEndpoint),
                syncToken = json.optString("syncToken", d.syncToken),
                syncIntervalMinutes = json.optInt("syncIntervalMinutes", d.syncIntervalMinutes),
                sponsorEndpoint = json.optString("sponsorEndpoint", d.sponsorEndpoint),
                updateFeedUrl = json.optString("updateFeedUrl", d.updateFeedUrl),
                autoCheckUpdates = json.optBoolean("autoCheckUpdates", d.autoCheckUpdates),
                rewardsEnabled = json.optBoolean("rewardsEnabled", d.rewardsEnabled)
            )
        }
    }
}
