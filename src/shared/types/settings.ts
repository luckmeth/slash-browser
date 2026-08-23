import { z } from 'zod'

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
  homepage: z.string().default('app://newtab'),
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
  /**
   * Start-page sections the user has hidden.
   *
   * A deny-list, like the toolbar: a section added in a later version shows up
   * by default rather than being invisible to everyone who once customised.
   */
  hiddenNewTabCards: z.array(z.string()).default([]),

  // --- sponsored tiles -------------------------------------------------------
  /**
   * Whether the start page may show a sponsored tile.
   *
   * Off by default, and it stays off until both this and an endpoint are set.
   * A browser whose pitch is that it blocks advertising does not get to switch
   * its own advertising on without being asked.
   */
  sponsoredTilesEnabled: z.boolean().default(false),
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
   * How translucent the chrome is, 0–100.
   *
   * Not everyone wants acrylic: it costs GPU time, it is ignored on Windows 10,
   * and over a busy wallpaper it hurts legibility. At 100 the bars are opaque
   * and the blur is dropped entirely, which is also the sensible setting on a
   * low-end machine.
   */
  glassOpacity: z.number().int().min(0).max(100).default(55),
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
   * Connections the download engine may open per file.
   *
   * Only used when the server supports range requests. More is not reliably
   * faster: a server that caps total bandwidth per client gains nothing, and
   * some refuse many parallel connections outright.
   */
  downloadConnections: z.number().int().min(1).max(8).default(4),
  /** Ceiling in bytes per second across all downloads. 0 = unlimited. */
  downloadBandwidthLimit: z.number().int().min(0).default(0),
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
   * Release feed to check for newer versions. Empty by default.
   *
   * Empty means Slash contacts nothing at all — there is no default endpoint,
   * because a browser that phones a server on first launch to ask about updates
   * has made an outbound request the user never agreed to.
   */
  updateFeedUrl: z.string().default(''),

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
