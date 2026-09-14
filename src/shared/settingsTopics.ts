/**
 * The settings screen, as things somebody can search for.
 *
 * Settings is a page of thirty groups, and finding one means knowing which
 * group it lives under — "is the ad blocker under Privacy or Content blocking?"
 * The command centre can answer that, but only if it knows what the screen
 * contains, and the screen is a TSX file it cannot read.
 *
 * So this is a list, and the cost of a list is that it drifts. That cost is paid
 * by `settingsGroups.test.ts`, which asserts every `title` here is a real
 * `<Group title>` in `SettingsPanel.tsx` — a topic pointing at a group that no
 * longer exists would open Settings filtered to nothing, which reads as the
 * search being broken rather than as a stale entry.
 *
 * `keywords` are the words people actually reach for, which are rarely the
 * group's own name: nobody searches for "Content blocking" when what they want
 * is to stop seeing adverts.
 */
export interface SettingsTopic {
  /** Must match a `<Group title>` on the settings page, exactly. */
  readonly title: string
  /** Extra words that should find it. Never shown. */
  readonly keywords: string
}

export const SETTINGS_TOPICS: readonly SettingsTopic[] = [
  { title: 'Appearance', keywords: 'theme dark light glass blur sharp text font effects' },
  { title: 'Import from another browser', keywords: 'chrome edge firefox bookmarks history migrate' },
  { title: 'Search', keywords: 'engine google duckduckgo keyword default query' },
  { title: 'Zoom', keywords: 'per-site magnify scale text size bigger smaller' },
  { title: 'Start page', keywords: 'new tab background wallpaper homepage' },
  { title: 'Slash Coin', keywords: 'rewards earn balance points crypto sign in' },
  { title: 'Sponsored placements', keywords: 'advertising adverts sponsor tiles banner income' },
  { title: 'Extensions', keywords: 'unpacked addon plugin chrome web store' },
  { title: 'Toolbar', keywords: 'buttons customise layout icons chrome' },
  { title: 'Saved sign-ins', keywords: 'passwords vault autofill login credentials' },
  { title: 'Content blocking', keywords: 'ads adblock trackers shield filters youtube popups' },
  { title: 'Browsing memory', keywords: 'index page content semantic search history recall' },
  { title: 'Publisher configuration', keywords: 'remote config feed advertiser' },
  { title: 'Profiles', keywords: 'accounts separate switch user data' },
  { title: 'Saved addresses', keywords: 'autofill forms postal shipping card' },
  { title: 'Sync', keywords: 'devices encrypted passphrase bookmarks backup' },
  { title: 'Keyboard shortcuts', keywords: 'keys accelerators hotkeys bindings' },
  { title: 'Media keys', keywords: 'play pause next track hardware global' },
  { title: 'Assistant', keywords: 'ai claude chatgpt provider model pane' },
  { title: 'Default browser', keywords: 'set default links open windows association' },
  { title: 'Restore points', keywords: 'snapshots time machine session recover' },
  { title: 'Privacy', keywords: 'permissions camera microphone location tracking private' },
  { title: 'AI and your page content', keywords: 'ai page text send provider translate gate' },
  { title: 'Downloads', keywords: 'folder location save files queue' },
  { title: 'Reading', keywords: 'reader mode reading list article' },
  { title: 'Right-click menu', keywords: 'context menu restore blocked' },
  { title: 'Download acceleration', keywords: 'connections segments speed multi-threaded idm' },
  { title: 'Video downloads', keywords: 'yt-dlp youtube media streams quality' },
  { title: 'Updates', keywords: 'version upgrade release channel install' },
  { title: 'Crash reports', keywords: 'minidump diagnostics telemetry error' }
]
