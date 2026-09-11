import { z } from 'zod'
import { UPDATE_FEED_DEFAULT } from './updates'

/**
 * Application settings. This schema is also the persistence format and the
 * migration target — `SettingsStore` parses whatever is on disk through it, so
 * adding a key with a default is a backward-compatible change.
 *
 * The privacy gates below are declared in Phase 0 deliberately, long before the
 * engines that read them exist. Later phases must check these flags rather than
 * introduce their own, which makes it structurally impossible for Web Memory or
 * the AI layer to ship an implicit default-on path.
 */
export const SettingsSchema = z.object({
  // --- Phase 1: core browser -------------------------------------------------
  /**
   * The default search engine.
   *
   * A plain string, not an enum of the four built-ins, so one of the user's
   * **own** engines can be the default. That is not only a convenience: a search
   * partnership pays against a URL carrying your partner code, and it only earns
   * anything if it is where searches actually go. An enum here made that
   * impossible — the partner engine could be typed with a keyword and never be
   * the default.
   *
   * An id matching nothing falls back to the schema default rather than
   * searching somewhere the user did not choose.
   */
  searchEngineId: z.string().default('google'),
  /**
   * User-defined search engines, triggered by typing their keyword first.
   *
   * "gh react hooks" searches GitHub without changing the default engine. The
   * keyword must be followed by a space to count, so a site whose name happens
   * to match a keyword — `gh.example.com` — still resolves as an address. A URL
   * without %s is treated as having the query appended, since that is the
   * commonest mistake and silently searching the wrong place is worse than
   * being forgiving.
   */
  customSearchEngines: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().max(60),
        /** Lower-cased, no whitespace — enforced where it is saved. */
        keyword: z.string().min(1).max(20),
        url: z.string()
      })
    )
    .default([]),
  /**
   * Whether the first-run walkthrough has been seen.
   *
   * A setting rather than a marker file so it lives with everything else the
   * profile knows, and so wiping the profile genuinely resets first-run. It is
   * set when the walkthrough is dismissed *by any route* — finishing it and
   * skipping it both count, because a walkthrough that reappears after being
   * declined is not an introduction, it is a nag.
   */
  onboardingCompleted: z.boolean().default(false),

  // --- media detection -------------------------------------------------------
  /**
   * Whether Slash watches responses for downloadable video and audio.
   *
   * On, because it is a feature people install a browser for. Switchable
   * because it is the one part of the browser that costs something on every
   * page: a `webRequest` listener is a main-process callback per response, and
   * principle 1 says no feature may add latency to the browsing path. Off
   * removes the listener rather than skipping its body — a switch that left the
   * cost in place would not be a switch.
   */
  detectPageMedia: z.boolean().default(true),
  /**
   * Whether to restore the right-click menu on sites that block it.
   *
   * On. A page cancelling `contextmenu` is usually there to stop people copying
   * a link or saving an image, and the browser is the user's software rather
   * than the site's. The cost is real and stated in the UI: a site with a
   * genuinely useful custom menu loses it, YouTube's player menu included.
   */
  restoreContextMenu: z.boolean().default(true),
  /** Whether the floating download button may appear over a playing video. */
  mediaOverlayButton: z.boolean().default(true),

  // --- docked assistant ------------------------------------------------------
  /**
   * Which AI assistant docks beside a page.
   *
   * A website, opened in a pane, that the user signs into themselves. Not an
   * API integration and not the AI action layer: no page content is sent
   * anywhere, and this setting turns nothing on that reads a page. Whether the
   * subscription works is between the user and that site, which is the whole
   * reason it is the real site rather than a key field.
   */
  assistantId: z
    .enum(['claude', 'chatgpt', 'gemini', 'perplexity', 'mistral', 'custom'])
    .default('claude'),
  /** Used only when `assistantId` is `custom`. https only. */
  assistantCustomUrl: z.string().default(''),

  // --- default browser -------------------------------------------------------
  /**
   * How many times Slash has offered to become the default browser.
   *
   * Capped at two by `PROMPT_LIMITS`. Windows cannot be told from code — the
   * user has to pick Slash in the Default apps screen themselves — so the offer
   * is a signpost, and a signpost shown a third time is a nag.
   */
  defaultBrowserAsks: z.number().int().default(0),
  /** Epoch ms of the last offer, so the second one is a fortnight later. */
  defaultBrowserAskedAt: z.number().int().default(0),
  /** "Don't ask again", honoured permanently. */
  defaultBrowserSuppressed: z.boolean().default(false),

  theme: z.enum(['system', 'light', 'dark']).default('system'),

  // --- personalisation -------------------------------------------------------
  /**
   * Accent colour for the whole interface.
   *
   * A workspace's own colour still overrides this while that workspace is
   * active — the workspace tint is about telling contexts apart, which is a
   * stronger claim on the accent than a global preference.
   */
  accentColor: z
    .enum(['default', 'blue', 'green', 'purple', 'amber', 'rose', 'teal'])
    .default('default'),
  /**
   * Zoom level per site, keyed by host.
   *
   * Chromium keeps zoom per *origin* inside a session, but that state does not
   * survive a restart and is not visible to us — so a site you had to zoom in on
   * every visit had to be zoomed in on again after every launch. Stored as a
   * level (Chromium's own scale, 0 = 100%) rather than a percentage, so it can
   * be handed straight back to `setZoomLevel` without a lossy conversion.
   *
   * Only non-default levels are kept: resetting a site to 100% removes its
   * entry rather than storing a zero, so the map does not grow with every site
   * ever visited.
   */
  siteZoom: z.record(z.string(), z.number()).default({}),
  /**
   * Toolbar buttons the user has hidden.
   *
   * A deny-list rather than an ordered allow-list, so a button added in a later
   * version appears by default instead of being invisible to everyone who ever
   * customised their toolbar. Every hidden button still has its keyboard
   * shortcut and its menu entry — hiding is about clutter, not capability, and a
   * setting that silently removed a feature would be a different thing.
   */
  hiddenToolbarButtons: z.array(z.string()).default([]),

  // --- new tab page ----------------------------------------------------------
  /**
   * The backdrop on the start page.
   *
   * These are CSS gradients rather than bundled photographs: an image set large
   * enough to look good on a 4K display would add tens of megabytes to an
   * installer for decoration, and fetching one would make opening a new tab an
   * outbound request. A gradient costs nothing and never phones anywhere.
   */
  newTabBackground: z
    .enum(['aurora', 'dusk', 'mesh', 'ember', 'deep', 'plain', 'custom'])
    .default('aurora'),
  /**
   * Absolute path to the user's own background image.
   *
   * Read from disk and inlined, never fetched. Only used when
   * `newTabBackground` is 'custom', so switching away keeps the path without
   * showing it.
   */
  newTabCustomBackground: z.string().default(''),
  // --- sponsored tiles -------------------------------------------------------
  /**
   * Whether sponsored placements may run.
   *
   * **On by default, and no longer exposed to the reader.** Sponsored
   * placements are how the browser is funded, so they are not optional — the
   * settings screen states that plainly rather than offering a switch that was
   * only ever going to be found by the people least willing to see an advert.
   *
   * The key survives because it is still a real gate: it stops the batch fetch
   * in `SponsorService.active`, whoever publishes the browser needs to be able
   * to turn the network off without shipping a release, and both
   * `SLASH_AD_SHOWCASE` and `SLASH_SPONSOR_PROBE` drive it.
   *
   * A default build still shows nothing: no `sponsorEndpoint` means no request
   * is made and there is nothing to display.
   */
  sponsoredTilesEnabled: z.boolean().default(true),
  /**
   * Where batches of sponsored creatives are fetched from.
   *
   * Empty by default, which makes the whole feature inert — no request is ever
   * made until an operator configures their own endpoint. Batched and matched
   * on-device: the request carries no identifier and no browsing data, and only
   * aggregate counts go back. See `docs/sponsored-tiles.md` for the contract.
   */
  sponsorEndpoint: z.string().default(''),
  /**
   * Where "Advertise on Slash" points, if anywhere.
   *
   * Empty by default, so a default install shows no such link at all. Held as a
   * plain setting rather than fetched from the portal deliberately: a link that
   * had to be looked up would mean a request from every start page, which is
   * the per-impression call the whole sponsored-tile design exists to avoid,
   * spent on a hyperlink.
   */
  advertisePortalUrl: z.string().default(''),
  /**
   * Slash Coin: whether qualifying browsing time is reported and rewarded.
   *
   * **Off on a fresh install, and it stays off until the user signs in.** This
   * is the one feature that sends a record of *when* somebody was browsing to
   * a server, which is precisely the thing principle 2 says does not happen
   * unless it was switched on. Nothing about which pages, ever — only closed
   * intervals of time — but "how long you used the browser, and when" is
   * personal data whatever it omits, so it is opt-in and says so.
   */
  rewardsEnabled: z.boolean().default(false),
  /**
   * Overrides the compiled rewards service address.
   *
   * For whoever publishes this build; empty means the address in
   * `shared/types/rewards.ts`.
   */
  rewardsEndpoint: z.string().default(''),
  /**
   * An opaque per-installation id, generated on first report.
   *
   * Not an identifier of the person: it is random, local, and travels only
   * beside a ledger already tied to their account. It exists so one account
   * farming across twenty fabricated machines is visible rather than invisible.
   */
  rewardsDeviceId: z.string().default(''),
  /**
   * Whether the one-time Slash Coin invitation has been shown.
   *
   * Once, ever. Principle 4 is that the browser does not nag: an invitation
   * that reappears is an advert for our own feature, and the rewards page is a
   * click away in Settings and on the start page for anybody who dismissed it.
   */
  rewardsPromptSeen: z.boolean().default(false),
  /**
   * Whether a sponsored notice may appear while browsing.
   *
   * The one advertising format that interrupts, so it has its own switch even
   * though sponsorship as a whole already has one. It appears in the browser's
   * own chrome and never inside a web page — injecting adverts into pages is
   * exactly what this browser blocks, and doing it ourselves would make the
   * product adware.
   */
  sponsoredNoticesEnabled: z.boolean().default(true),
  /**
   * How often notices have been shown. Persisted so restarting is not a way to
   * see more of them.
   */
  sponsorNoticeState: z
    .object({
      lastShownAt: z.number().default(0),
      shownToday: z.number().int().default(0),
      day: z.string().default('')
    })
    .default({ lastShownAt: 0, shownToday: 0, day: '' }),
  /**
   * Where the publisher's remote configuration lives, if anywhere.
   *
   * Empty by default, so a fresh install never asks anything how it should
   * behave — a browser that phones home on launch is doing what this one is
   * sold as not doing. Set by whoever builds the installer. The request carries
   * no identifier and the response is identical for every caller.
   */
  remoteConfigEndpoint: z.string().default(''),
  /**
   * Remapped keyboard shortcuts: command id → Electron accelerator.
   *
   * Only genuine differences are stored. A binding equal to the default is
   * pruned on write, so changing a default later reaches everybody instead of
   * being silently pinned to whatever it was the day somebody opened this
   * screen. Ids are derived from the menu path — see `menus/shortcutMap.ts`.
   */
  keyboardShortcuts: z.record(z.string(), z.string()).default({}),
  /**
   * Whether the hardware media keys control the browser.
   *
   * On by default, but only while Slash has focus — see `mediaKeysAlwaysOn`.
   */
  mediaKeysEnabled: z.boolean().default(true),
  /**
   * Keep the media keys even when Slash is in the background.
   *
   * Off by default, because `globalShortcut` is exactly that: taking these keys
   * permanently means pressing pause while listening to something else pauses a
   * tab in a minimised browser instead, and nothing on screen explains why.
   */
  mediaKeysAlwaysOn: z.boolean().default(false),
  /**
   * Whether bookmarks and the reading list are synced between machines.
   *
   * Off by default and inert without an endpoint, so a fresh install contacts
   * nothing. What is uploaded is **ciphertext only** — the passphrase never
   * leaves the machine, and no key derived from it is stored.
   */
  syncEnabled: z.boolean().default(false),
  /**
   * Whether history joins them.
   *
   * A **separate** switch from `syncEnabled`, and off even when sync is on,
   * because history is a different order of exposure from a bookmark list and
   * turning sync on should not quietly start uploading it. It is also the one
   * collection whose ids are HMACs rather than natural keys: reading-list items
   * travel under their own URL, which is a small leak for a few saved articles
   * and an unacceptable one for every page somebody has visited.
   *
   * Bounded by a retention window and a hard cap — see `historySync.ts`.
   */
  syncHistory: z.boolean().default(false),
  /** Where the encrypted blobs go. Empty by default; see docs/sync.md. */
  syncEndpoint: z.string().default(''),
  /** Bearer token for the sync account, if the server wants one. */
  syncToken: z.string().default(''),
  /** How often to sync while the browser is open, in minutes. */
  syncIntervalMinutes: z.number().int().min(5).max(1440).default(30),
  /** Compact trades padding for rows on screen. */
  uiDensity: z.enum(['comfortable', 'compact']).default('comfortable'),
  /**
   * Where the tab strip lives.
   *
   * Vertical is the better answer past about fifteen tabs — horizontal titles
   * truncate to nothing while a list just keeps scrolling — but it costs screen
   * width permanently, which is the wrong trade for someone who keeps four tabs
   * open. Hence a preference rather than a default.
   */
  tabStripPosition: z.enum(['top', 'left']).default('top'),
  /**
   * Hide the toolbar and tabs until the pointer reaches the top of the window.
   *
   * For reading rather than for browsing: the chrome is three rows tall, and on
   * a long article that is three rows of browser between you and the text. With
   * this on, the page takes the whole window and the bars slide back the moment
   * the pointer goes looking for them.
   *
   * Off by default. Chrome that vanishes is a surprise the first time it
   * happens, and a browser whose address bar is missing reads as broken rather
   * than as focused.
   */
  autoHideChrome: z.boolean().default(false),
  /**
   * How translucent the chrome is, 0–100.
   *
   * Not everyone wants acrylic: it costs GPU time, it is ignored on Windows 10,
   * and over a busy wallpaper it hurts legibility. At 100 the bars are opaque
   * and the blur is dropped entirely, which is also the sensible setting on a
   * low-end machine.
   */
  glassOpacity: z.number().int().min(0).max(100).default(0),
  restoreTabsOnStartup: z.boolean().default(true),
  /** Ask before running a downloaded file with an executable extension. */
  warnOnExecutableDownload: z.boolean().default(true),
  /**
   * Whether ordinary browsing history is recorded at all.
   *
   * Distinct from `indexHistory` below: this governs the plain
   * back-of-the-browser history list, whereas `indexHistory` governs whether
   * that history is additionally fed to the Phase 5 searchable memory index.
   * Turning this off means nothing is written in the first place.
   */
  recordHistory: z.boolean().default(true),
  /** Empty = the OS default downloads folder. */
  downloadDirectory: z.string().default(''),
  /** Prompt for a save location on every download instead of using the folder above. */
  askWhereToSaveDownloads: z.boolean().default(false),
  /**
   * Whether Slash looks at the clipboard for download links.
   *
   * **Off by default and it must stay that way.** Reading the clipboard is
   * reading everything the user copies — passwords, account numbers, private
   * messages. Even switched on, it is read only when a Slash window takes
   * focus, never on a timer, so it cannot see what is copied inside another
   * application. See `ClipboardWatcher`.
   */
  watchClipboardForDownloads: z.boolean().default(false),
  /**
   * Connections the download engine may open per file.
   *
   * Only used when the server supports range requests. More is not reliably
   * faster: a server that caps total bandwidth per client gains nothing, and
   * some refuse many parallel connections outright.
   *
   * Defaults to 8 - the same as IDM's default, and double what this used to
   * ask for. Four was chosen when segments were split statically at the start
   * and never revisited, where extra connections mostly bought extra ways for
   * one slow range to hold the file up. Now that an idle connection steals half
   * of whatever is furthest from done, more of them genuinely finish sooner.
   */
  downloadConnections: z.number().int().min(1).max(16).default(8),
  /**
   * Hand downloads Slash cannot make to a user-installed yt-dlp.
   *
   * Off by default, and Slash never installs, bundles or downloads the tool.
   * Some sites serve media in a form no observer can turn into a file — an
   * address that exists only inside the player's session, or a transport
   * framing the player unwraps in the page. Reaching those means impersonating
   * a different client or running the site's own signature code, which is
   * defeating an access control, and this browser does not do that itself.
   *
   * A tool the user chose to install is their decision rather than ours. This
   * switch is how they make it, and the UI always says which downloads went
   * through yt-dlp and which the browser made.
   */
  useExternalDownloader: z.boolean().default(false),
  /** Explicit path to yt-dlp. Empty means look on PATH. */
  externalDownloaderPath: z.string().default(''),
  /**
   * Announce each finished download, naming the file.
   *
   * The queue-level "Downloads finished" notice is a *completion action* the
   * user opts into; this is the ordinary per-file one every browser has. On by
   * default because a transfer that only appears on a panel you had to open is
   * a transfer nobody sees.
   */
  notifyOnDownloadComplete: z.boolean().default(true),
  /**
   * Fetch yt-dlp automatically the first time Slash runs.
   *
   * Slash cannot download most video sites on its own — that capability lives in
   * yt-dlp, a separate public-domain program — and requiring a trip to Settings
   * before the feature works means most people never find it.
   *
   * It is still a **request to github.com that a fresh install makes on its
   * own**, which principle 2 does not let pass silently: the download is from
   * the official repository only, its bytes are checked against the published
   * SHA-512 before anything is marked installed, and this switch turns it off.
   * Nothing else about the browser reaches the network unasked.
   */
  ytDlpInstallOnFirstRun: z.boolean().default(true),
  /**
   * Whether the first-run fetch has been tried.
   *
   * Not a preference — a record, so a machine that was offline on first launch
   * does not re-attempt on every start for ever. Settings still offers the
   * manual install button, which is the recovery path.
   */
  ytDlpFirstRunAttempted: z.boolean().default(false),
  /**
   * Keep the managed yt-dlp current.
   *
   * Installing once is not enough: extractor fixes ship every few weeks, so a
   * copy fetched today stops being able to download video within a month or
   * two — silently, because a stale extractor fails per-site rather than
   * loudly. This checks every two weeks and only replaces the copy in
   * `userData`.
   *
   * It never touches a yt-dlp the user installed themselves. That one belongs
   * to them and to whatever else on the machine uses it.
   */
  ytDlpAutoUpdate: z.boolean().default(true),
  /** When the update check last ran. A record, not a preference. */
  ytDlpLastUpdateCheck: z.number().int().min(0).default(0),
  /**
   * Keep the filter lists current.
   *
   * The single biggest difference between this blocker and Brave's was never
   * technique — it was that Brave's rules are refreshed continuously and these
   * were compiled into the installer and never fetched again. A list bundled in
   * March is wrong by May, silently, because a stale rule fails per-site rather
   * than loudly.
   *
   * Fetched from the publishers' own addresses, checked for being a filter list
   * before anything is replaced, and degrading to the bundled copies on any
   * failure.
   */
  filterListsAutoUpdate: z.boolean().default(true),
  /** When the list check last ran. A record, not a preference. */
  filterListsLastCheck: z.number().int().min(0).default(0),
  /**
   * Draw the browser's own interface on an opaque surface.
   *
   * The chrome is created transparent so the window's acrylic shows the desktop
   * through it, and that is the whole look. It has a cost that is easy to feel
   * and hard to name: **Chromium cannot do subpixel text antialiasing onto a
   * transparent backing.** There is nothing behind the glyphs to blend against,
   * so every label in the browser falls back to grayscale, which is why Slash
   * reads as softer than Chrome or Edge on the same screen.
   *
   * On, the interface becomes solid and text renders with full subpixel
   * antialiasing. Off, the glass stays.
   *
   * It cannot change while the window is open — `transparent` is fixed when a
   * view is constructed — so the copy says so rather than appearing to do
   * nothing.
   */
  sharpText: z.boolean().default(false),
  /** Ceiling in bytes per second across all downloads. 0 = unlimited. */
  downloadBandwidthLimit: z.number().int().min(0).default(0),
  /**
   * Named queues downloads can be sorted into and run independently.
   *
   * Kept in settings rather than in a table because a queue is a handful of
   * preferences, not a record with a history - and because the downloads that
   * reference one already carry the id, so a queue disappearing strands
   * nothing (`selectStartable` falls back to the first).
   */
  downloadQueues: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(64),
        maxConcurrent: z.number().int().min(1).max(10),
        paused: z.boolean()
      })
    )
    .min(1)
    .max(12)
    .default([{ id: 'main', name: 'Main', maxConcurrent: 3, paused: false }]),
  /**
   * File the download into a folder named for its kind.
   *
   * Off by default: turning it on means files stop appearing where the last one
   * did, and somebody who did not ask for it goes looking in Downloads and
   * finds nothing.
   */
  sortDownloadsByCategory: z.boolean().default(false),
  /**
   * What to do when every download has finished.
   *
   * Everything past `notify` ends the session, so it is offered with a
   * cancellable countdown rather than acted on immediately - see
   * `COMPLETION_GRACE_MS`.
   */
  downloadCompletionAction: z
    .enum(['nothing', 'notify', 'quit', 'sleep', 'shutdown'])
    .default('nothing'),
  /**
   * Whether Slash takes large downloads from Chromium and accelerates them.
   *
   * On, because a download manager nothing reaches is not a feature. Taking over
   * means cancelling Chromium's transfer and requesting the URL again, which is
   * how every download manager works and is why `shouldTakeOver` refuses
   * anything small, anything of unknown length, and anything that is not a plain
   * web address — see the note there.
   */
  accelerateDownloads: z.boolean().default(true),

  // --- content blocking ------------------------------------------------------
  /**
   * Block advertising and tracking requests.
   *
   * On by default: these requests are cancelled before they leave the machine,
   * so this saves bandwidth and time as well as removing the ads.
   */
  blockAds: z.boolean().default(true),
  /**
   * Refuse navigation to hosts on the known-malicious list.
   *
   * This is domain reputation, not virus scanning — a browser cannot inspect a
   * file for malware, and the UI must not imply that it does.
   */
  blockMaliciousSites: z.boolean().default(true),
  /**
   * Remove YouTube's video ad breaks.
   *
   * Separate from `blockAds` because it works by a different and more invasive
   * mechanism. YouTube's ad breaks are not network requests — they arrive as a
   * field inside the watch page itself — so the only way to remove them is to run
   * a script in the page's own JavaScript context before its scripts read that
   * field. Every other blocking feature here cancels requests and never touches
   * page context.
   *
   * Scoped to YouTube, deletes three named fields, and switchable off. It does
   * not affect sponsor segments the creator reads out, which are part of the
   * video itself.
   */
  /**
   * Whether Slash may run its own scripts inside a page's JavaScript context.
   *
   * This is the one capability that reaches into the page itself, so it gets an
   * explicit switch rather than being implied by the shield settings. Two
   * scripts depend on it: the YouTube ad-break strip, and the `window.open`
   * defuser that stops a refused popup from killing the click that asked for it.
   *
   * Turning it off also releases the debugger client Slash holds on each tab —
   * relevant if another tool needs it.
   */
  allowPageScripts: z.boolean().default(true),
  /**
   * Folders of unpacked extensions to load on every launch.
   *
   * Paths, not ids: Electron discards loaded extensions when the app exits, so
   * the folder is the only durable reference. There is no Chrome Web Store
   * install flow — Electron has none — so these are folders the user chose.
   */
  extensionPaths: z.array(z.string()).default([]),
  blockYouTubeVideoAds: z.boolean().default(true),
  /** Sites the user has turned blocking off for. */
  blockingAllowedSites: z.array(z.string()).default([]),
  /**
   * Block windows the page opened without the user clicking anything.
   *
   * Separate from `blockAds` because they fail differently: a wrongly blocked ad
   * is invisible, a wrongly blocked popup looks like a broken link. Anything
   * blocked here is held and offered, never silently dropped.
   */
  blockPopups: z.boolean().default(true),
  /**
   * How to treat signals that are suspicious but not conclusive.
   *
   * Rules-based blocking is identical in both modes. Strict additionally stops
   * unclicked cross-site popups and warns on unclicked cross-site navigation —
   * judgement calls, which is why they are opt-in.
   */
  protectionMode: z.enum(['standard', 'strict']).default('standard'),
  /** Extra domains to block, one per line, authored by the user. */
  customBlockRules: z.array(z.string()).default([]),

  // --- updates ---------------------------------------------------------------
  /**
   * Release feed to check for newer versions.
   *
   * Defaults to Slash's own, because a browser that never learns about a
   * security fix is a worse outcome than an update check — Chromium ships
   * fixes roughly monthly and this is how they arrive. The request carries no
   * identifier, no cookie and no per-installation key, and the answer is the
   * same for everybody, so it cannot be used to count installations.
   *
   * Emptying this stops it dead: no address, no check, nothing contacted.
   */
  updateFeedUrl: z.string().default(UPDATE_FEED_DEFAULT),
  /**
   * Whether this profile has been offered the release feed already.
   *
   * Bookkeeping, not a preference, and deliberately not in the settings UI.
   * Profiles written before the feed had a default hold `updateFeedUrl: ""` on
   * disk, and a schema default cannot reach a key that is present -- so those
   * installs would never check for an update again. This marks the one-time
   * adoption in `adoptDefaultFeed`, so that filling the field in happens once
   * and a field cleared afterwards stays cleared.
   */
  updateFeedAdopted: z.boolean().default(false),
  /**
   * Check the feed on launch and every few hours.
   *
   * On by default, and still contacts nothing while `updateFeedUrl` is empty.
   * It is **not** empty on a fresh install -- it carries Slash's own feed -- so
   * a default install does check on launch and every few hours. The pair is
   * deliberate: the switch that decides *whether* to talk to a server is the
   * address, and this one only decides how often once that address exists.
   */
  updateAutoCheck: z.boolean().default(true),
  /**
   * Fetch the package as soon as a newer version is found.
   *
   * On, so that saying yes to an update is one click rather than a wait. The
   * cost is real -- it is a large download on somebody's connection -- so it
   * is a switch, and turning it off leaves the check working and the download
   * manual. **Installing always asks**, whatever this is set to.
   */
  updateAutoDownload: z.boolean().default(true),

  // --- cleanup mode ----------------------------------------------------------
  /** Which Cleanup Mode the Clean This Page button uses. */
  cleanupMode: z.enum(['light', 'balanced', 'aggressive']).default('balanced'),
  /**
   * Hosts where cleanup is switched off.
   *
   * Essential rather than a nicety: the rules fire on the *shape* of an element,
   * so there will always be a site where the thing named "sticky" is the thing
   * you need.
   */
  cleanupDisabledHosts: z.array(z.string()).default([]),

  // --- Phase 3: performance --------------------------------------------------
  performanceMode: z.enum(['off', 'balanced', 'aggressive']).default('balanced'),
  /**
   * Adapt to the machine Slash is running on.
   *
   * On by default. It measures memory, processor threads and whether the
   * machine is on battery, and on a low-powered one it turns off background
   * blur and animation, sleeps background tabs sooner, and uses fewer parallel
   * download connections. On a comfortable machine it changes nothing at all.
   *
   * It never overrides a performance mode somebody chose by hand — it decides
   * what happens when nobody has said. Turning it off gives every machine the
   * full interface, which is the right switch to have when the measurement is
   * wrong about yours.
   */
  hardwareOptimisation: z.boolean().default(true),

  // --- Phase 6: time machine -------------------------------------------------
  /** Keep automatic restore points for this many days. 0 = keep only manual ones. */
  snapshotRetentionDays: z.number().int().min(0).max(365).default(14),
  /**
   * Include Chromium's page state in snapshots.
   *
   * Off by default and deliberately so: page state carries **form values** as
   * well as scroll position, so enabling this writes whatever has been typed
   * into a form — potentially a half-entered password — into the local database.
   * Scroll position is captured separately and is unaffected by this setting.
   */
  restoreFormState: z.boolean().default(false),

  // --- Phase 5: web memory privacy gates (default OFF) -----------------------
  /** Index visit metadata (url, title, timestamp). */
  indexHistory: z.boolean().default(false),
  /** Index extracted page *text*. Separate, stricter gate than indexHistory. */
  indexPageContent: z.boolean().default(false),
  /** Origins never indexed, regardless of the flags above. */
  excludedOrigins: z.array(z.string()).default([]),
  /** Days to retain indexed content. 0 = forever. */
  memoryRetentionDays: z.number().int().min(0).default(90),
  /** Opt-in local ONNX embedding layer. Keyword search works without it. */
  semanticSearchEnabled: z.boolean().default(false),
  /** Keep private-window visits out of the memory index. */
  excludePrivateFromMemory: z.boolean().default(true),

  // --- Phase 7: AI (default OFF, no provider configured) ---------------------
  aiProvider: z.enum(['none', 'anthropic', 'openai-compatible']).default('none'),
  /** Never sent to the renderer; the main process substitutes a redaction marker. */
  aiModel: z.string().default('claude-sonnet-5'),
  /** Page *content* may only reach a provider with a per-request approval too. */
  aiMayReadPageContent: z.boolean().default(false),
  /** For the OpenAI-compatible adapter — Ollama, LM Studio, a local server. */
  aiBaseUrl: z.string().default('http://localhost:11434/v1'),
  /**
   * What "Translate" translates into.
   *
   * A plain language name rather than a code, because it is passed straight to
   * a language model and "Brazilian Portuguese" is a more useful instruction
   * than "pt-BR".
   */
  translateTargetLanguage: z.string().default('English')
})

export type Settings = z.infer<typeof SettingsSchema>

/** Every key has a `.default()`, so parsing `{}` yields the full default object. */
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

/** Keys the renderer is allowed to write. Anything else is rejected by the handler. */
export const WRITABLE_SETTING_KEYS = Object.keys(SettingsSchema.shape) as (keyof Settings)[]

/**
 * A patch: only the keys the caller actually sent.
 *
 * `SettingsSchema.partial()` cannot be used for this, and the reason is subtle
 * enough that it shipped and stayed hidden for a long time. Every field here
 * carries a `.default()`, and `.partial()` wraps that in an optional without
 * removing it — so an absent key still parses to its **default** rather than
 * being left out. Measured: `SettingsSchema.partial().parse({ blockAds: false })`
 * returns all 74 keys.
 *
 * Fed to `SettingsStore.update`, which merges the patch over the current
 * settings, that meant every change reset every *other* setting to its default.
 * Turn on two things and the first one came back off — which is exactly how it
 * was reported: "most of the switches are not working".
 *
 * So the default is stripped before the key is made optional. An absent key is
 * then genuinely absent, and the merge only touches what was sent.
 */
export const SettingsPatchSchema = z.object(
  Object.fromEntries(
    Object.entries(SettingsSchema.shape).map(([key, field]) => [key, stripDefault(field).optional()])
  ) as z.ZodRawShape
  // The shape is built at runtime, so its static type is only `ZodTypeAny` per
  // key. The cast restores what it actually is — every key of `Settings`,
  // optional, validated — so callers keep full type checking on a patch.
) as unknown as z.ZodType<Partial<Settings>>

export type SettingsPatch = Partial<Settings>

/**
 * The schema without its default.
 *
 * Written defensively across zod's two spellings — `removeDefault()` and the
 * inner type on `_def` — because this is load-bearing and a zod upgrade that
 * renamed it would silently restore the bug rather than fail to compile.
 */
function stripDefault(field: z.ZodTypeAny): z.ZodTypeAny {
  const candidate = field as unknown as {
    removeDefault?: () => z.ZodTypeAny
    _def?: { innerType?: z.ZodTypeAny; defaultValue?: unknown }
  }
  if (typeof candidate.removeDefault === 'function') return candidate.removeDefault()
  if (candidate._def?.innerType && candidate._def.defaultValue !== undefined) {
    return candidate._def.innerType
  }
  return field
}
