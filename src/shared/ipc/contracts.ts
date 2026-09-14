import { z } from 'zod'
import {
  AdvertiserResultSchema,
  AdvertiserStateSchema,
  CampaignInputSchema,
  CompanyInputSchema
} from '../types/advertising'
import {
  CoinProfileInputSchema,
  CoinProfileResultSchema,
  CoinProfileSchema,
  RewardsStatusSchema,
  RewardsSignInResultSchema
} from '../types/rewards'
import { PrintChoicesSchema, PrintPreviewSchema } from '../types/print'
import { SettingsPatchSchema, SettingsSchema } from '../types/settings'
import { TabsSnapshotSchema, TabSchema, ClosedTabSchema } from '../types/tab'
import { TabGroupSchema } from '../types/tabGroup'
import {
  WorkspacesSnapshotSchema,
  WORKSPACE_COLORS,
  WORKSPACE_ICONS,
  DEFAULT_WORKSPACE_ICON
} from '../types/workspace'
import { PerformanceSnapshotSchema } from '../types/performance'
import { OmniboxStateSchema, SuggestionSchema } from '../types/omnibox'
import { SnapshotSchema, SnapshotDetailSchema } from '../types/snapshot'
import { MemoryResultSchema, MemoryStatsSchema, ParsedQuerySchema } from '../types/memory'
import { SemanticStatusSchema } from '../types/semantic'
import { ImportSourceSchema, ImportSummarySchema } from '../types/importer'
import { ReaderResultSchema } from '../types/reader'
import { DownloadPrioritySchema, EngineDownloadSchema } from '../types/downloadEngine'
import { DownloadScanSchema, MediaScanSchema, SiteGrabSchema } from '../types/downloadGuardian'
import { TabAnalysisSchema } from '../types/tabBrain'
import { CleanupModeSchema, CleanupResultSchema, CleanupStatusSchema } from '../types/cleanup'
import { PageInsightSchema } from '../types/pageInsight'
import { RedirectChainSchema } from '../types/redirectChain'
import { AiHubStatusSchema, AiProviderIdSchema } from '../types/aiHub'
import { AiComparisonSchema, ComparePreviewSchema } from '../types/aiCompare'
import { CrashReportSchema } from '../types/diagnostics'
import { RemoteConfigSchema } from '../types/remoteConfig'
import { SavedAddressSchema } from '../types/address'
import { SyncStatusSchema } from '../types/sync'
import { UpdateStatusSchema } from '../types/updates'
import { PageChangeSchema, WatchStatusSchema } from '../types/watch'
import { MissionStatusSchema } from '../types/mission'
import {
  BlockingStatusSchema,
  PopupBlockedSchema,
  NavigationNoticeSchema,
  ShieldCountsSchema
} from '../types/blocking'
import {
  ActionPlanSchema,
  AiActivitySchema,
  AiStatusSchema,
  EgressPreviewSchema
} from '../types/ai'
import {
  PermissionEventSchema,
  PermissionGrantSchema,
  PermissionKindSchema,
  PermissionPolicySchema,
  PermissionRequestSchema
} from '../types/permission'
import { HistoryEntrySchema, BookmarkSchema, DownloadItemSchema } from '../types/browsing'
import { ReadingItemSchema } from '../types/readingList'
import { SponsorStatusSchema, SponsoredTileSchema } from '../types/sponsor'
import { LoginFormSchema, VaultStatusSchema } from '../types/logins'
import { ExtensionsStatusSchema } from '../types/extensions'
import type { InvokeChannel, EventChannel } from './channels'

export {
  INVOKE_CHANNELS,
  EVENT_CHANNELS,
  isInvokeChannel,
  isEventChannel,
  type InvokeChannel,
  type EventChannel
} from './channels'

/**
 * THE SINGLE SOURCE OF TRUTH FOR THE IPC BOUNDARY.
 *
 * Every privileged channel is declared here with a zod schema for its request and
 * its response. `src/main/ipc/registry.ts` is the only file permitted to call
 * `ipcMain.handle`, and it refuses to register a channel that is not in this map.
 *
 * Adding a capability therefore starts here, which means no handler can quietly
 * come into existence without a validated payload shape.
 */

export interface ChannelContract {
  readonly request: z.ZodType
  readonly response: z.ZodType
}

// --- payload schemas --------------------------------------------------------

export const AppInfoSchema = z.object({
  /** Whether the window asking is a private one. */
  isPrivate: z.boolean().default(false),
  name: z.string(),
  version: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.string()
})
export type AppInfo = z.infer<typeof AppInfoSchema>

/**
 * Spike B evidence. Proves better-sqlite3 loaded against the Electron ABI, opened
 * a file in userData, ran the migration chain, and survived asar packaging —
 * reported from the running app rather than inferred from a successful build.
 */
export const DbStatusSchema = z.object({
  path: z.string(),
  sqliteVersion: z.string(),
  schemaVersion: z.number().int(),
  walEnabled: z.boolean(),
  foreignKeysEnabled: z.boolean(),
  roundTripOk: z.boolean()
})
export type DbStatus = z.infer<typeof DbStatusSchema>

export const OverlayStateSchema = z.object({
  visible: z.boolean(),
  surface: z.enum([
    'none',
    'spike',
    'command-bar',
    'permission-prompt',
    'tab-search',
    'reader',
    'shield',
    'onboarding',
    'passwords',
    'command-palette',
    'shortcuts',
    'cleanup',
    /** Print preview: what will come out of the printer, before it does. */
    'print',
    /** A sponsored notice, in the browser's own chrome. Never inside a page. */
    'sponsor-notice',
    /**
     * The download picker: every format this page can be saved as.
     *
     * Modal, unlike the chip that opens it. By this point the user has asked a
     * question and is choosing an answer, so covering the page is correct —
     * and the list needs room the chip does not have.
     */
    'media-picker',
    /**
     * "There is a video here you can download", floating over the page.
     *
     * The one surface that appears without being asked for and stays. Sized to a
     * chip in the corner rather than the window, because an overlay swallows
     * every click inside its bounds — a full-window one would make the video it
     * is pointing at unclickable, which is a special kind of useless.
     *
     * Passive: it never takes the overlay from a surface the user opened, and it
     * comes back on its own when that surface closes.
     */
    'media-offer',
    /**
     * "There is an update. Install it, or not, but answer."
     *
     * Modal and full-window, which almost nothing else here is allowed to be.
     * The justification is that a chip already existed and was ignorable
     * enough that a browser advertising an update it could not actually fetch
     * went unnoticed. Shown at most **once per launch** — see `launchPrompt.ts`
     * for why not once per check — and never before the first check has come
     * back, so it cannot delay startup.
     */
    'update-required',
    /**
     * A transient message: what happened, when the answer is "nothing".
     *
     * In the overlay because it has to be readable over a web page, and sized to
     * a small strip rather than the window — an overlay swallows clicks inside
     * its own bounds, and a full-window one would make the page inert for as
     * long as a toast was showing.
     */
    'notice'
  ])
})
export type OverlayState = z.infer<typeof OverlayStateSchema>

const TabIdSchema = z.object({ tabId: z.string() })

/** What one page stated about itself. `alignFacts` turns several into a table. */
export const PageFactsSchema = z.object({
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  siteName: z.string().nullable(),
  fields: z.record(z.string(), z.string()),
  headings: z.array(z.string()),
  wordCount: z.number().int()
})

/** The raw signals behind the Site Trust view. `buildTrustReport` reads these. */
export const TrustSignalsSchema = z.object({
  url: z.string(),
  blocked: z.object({
    ads: z.number().int(),
    trackers: z.number().int(),
    popups: z.number().int(),
    redirects: z.number().int()
  }),
  siteAllowed: z.boolean(),
  blockingEnabled: z.boolean(),
  redirectHops: z.number().int(),
  redirectThroughTracker: z.boolean(),
  grants: z.array(
    z.object({
      kind: z.string(),
      policy: z.string(),
      expiresAt: z.number().nullable()
    })
  ),
  denied: z.array(z.string()),
  flaggedDownloads: z.number().int()
})

/** One day of protection counters, exactly as the ledger holds them. */
export const ProtectionDaySchema = z.object({
  day: z.string(),
  ads: z.number().int(),
  trackers: z.number().int(),
  popups: z.number().int(),
  redirects: z.number().int(),
  tabsHibernated: z.number().int(),
  bytesFreed: z.number().int(),
  duplicatesClosed: z.number().int(),
  downloadsFlagged: z.number().int(),
  sessionsRestored: z.number().int(),
  tabsRestored: z.number().int()
})

export const HistoryQuerySchema = z.object({
  query: z.string().default(''),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0)
})

/**
 * Actions a menu accelerator triggers that only the UI can perform — focusing
 * the omnibox, opening a panel. Routed as an event rather than handled in main
 * because the state they act on (which input has focus, which panel is open)
 * lives in the renderer.
 */
export const UiCommandSchema = z.object({
  command: z.enum([
    'focus-omnibox',
    'open-history',
    'open-bookmarks',
    'open-downloads',
    'open-settings',
    'open-performance',
    'open-protection',
    'open-trust',
    'open-compare',
    'open-find',
    'open-permissions',
    'open-timemachine',
    'open-memory',
    'open-tabbrain',
    'open-insight',
    'open-redirects',
    'open-mission',
    'open-ai',
    'open-reading',
    'bookmark-current-tab',
    /** Saves the active tab to the read-later queue. */
    'save-to-reading',
    'close-panel',
    /** The pointer left the top of the window while auto-hide is on. */
    'hide-chrome',
    /**
     * The pointer reached the top edge while the chrome was auto-hidden.
     *
     * Sent from main rather than decided in the renderer, because the pixels
     * this gesture happens in do not belong to us - see
     * `BrowserWindowController.setChromeAutoHidden`.
     */
    'reveal-chrome'
  ]),
  /**
   * What the command is about, where it needs one.
   *
   * Only `open-settings` reads it today, as the group to filter that screen to,
   * so the command centre can land somebody on the setting they searched for
   * rather than at the top of thirty groups. Optional and bounded: a command
   * with no argument behaves exactly as it always did, and a renderer cannot
   * push an unbounded string through a broadcast every privileged view receives.
   */
  arg: z.string().max(120).optional()
})
export type UiCommand = z.infer<typeof UiCommandSchema>

// --- invoke channels --------------------------------------------------------

/**
 * Whether Slash has actually seen its ad strip run in a page.
 *
 * Four states rather than a boolean, because "we could not read the page" and
 * "the script did not run" are different facts and collapsing them would make
 * this check worse than not having one.
 */
export const ShieldVerificationSchema = z.object({
  verdict: z.enum(['unknown', 'verified', 'failed', 'off']),
  at: z.number().nullable(),
  host: z.string().nullable()
})

export const invokeContracts = {
  'app:info': { request: z.void(), response: AppInfoSchema },
  'diagnostics:dbStatus': { request: z.void(), response: DbStatusSchema },

  'settings:getAll': { request: z.void(), response: SettingsSchema },
  // `SettingsPatchSchema`, never `SettingsSchema.partial()`: the latter still
  // applies every field's `.default()` to absent keys, so a one-key patch
  // arrived as all 74 and reset everything else. See the note on the schema.
  'settings:update': { request: SettingsPatchSchema, response: SettingsSchema },

  /** Ranked suggestions for what has been typed so far. */
  'omnibox:suggest': {
    request: z.object({ query: z.string() }),
    response: z.array(SuggestionSchema)
  },
  /**
   * Chrome publishes the dropdown state; main sizes and shows the overlay and
   * forwards the state to it. Keeping selection in the chrome document means the
   * arrow keys keep working while focus stays in the text field.
   */
  'omnibox:setState': { request: OmniboxStateSchema, response: z.void() },
  /**
   * Pulled by the overlay document when it mounts.
   *
   * `overlay.show()` creates the view and loads its document asynchronously, so
   * the first pushed state arrives before any listener exists and is lost. The
   * overlay therefore asks for the current state rather than relying on having
   * caught the push.
   */
  'omnibox:getState': { request: z.void(), response: OmniboxStateSchema.nullable() },
  'omnibox:accept': {
    request: z.object({ tabId: z.string(), suggestion: SuggestionSchema }),
    response: z.void()
  },
  'omnibox:dismiss': { request: z.void(), response: z.void() },

  'overlay:setState': { request: OverlayStateSchema, response: OverlayStateSchema },
  /**
   * What the overlay is currently showing, from the controller's own record.
   *
   * Exists for the mount race: the surface that caused the overlay document to
   * load was announced on `overlay:stateChanged` before the document could
   * listen. Asking per-feature ("is a permission pending? is the omnibox
   * open?") only ever covered the surfaces someone remembered to ask about —
   * the first-ever surface of any other kind mounted to nothing and left an
   * invisible modal overlay swallowing input.
   */
  'overlay:getState': { request: z.void(), response: OverlayStateSchema },
  /**
   * Runs a UI command from a view that cannot reach the chrome document.
   *
   * The command palette lives in the **overlay**, and side panels are state in
   * the **chrome** — two separate documents that share no DOM and no events. A
   * `CustomEvent` dispatched in one is invisible to the other, so the palette
   * has to ask main to broadcast, exactly as a menu accelerator does.
   */
  'ui:run': { request: UiCommandSchema, response: z.void() },
  /**
   * Every keyboard shortcut, read out of the live application menu.
   *
   * Derived rather than transcribed. A hand-written sheet drifts the first time
   * an accelerator is reassigned, and a shortcut list that lies is worse than
   * none — it teaches the wrong key and the user stops trusting the feature.
   */
  /**
   * Opens the app menu as a native OS menu.
   *
   * Native rather than a React dropdown: a CSS menu in the chrome document is
   * composited under the page view and clips at the window edge, both of which
   * have already bitten this codebase.
   */
  'menu:showAppMenu': { request: z.void(), response: z.void() },
  /**
   * Renders the page as it would print, with the current choices.
   *
   * A real render rather than an approximation — the same `printToPDF` call the
   * "Save as PDF" button makes. A preview that is not what prints is worse than
   * no preview, because it is trusted.
   */
  'print:preview': {
    request: z.object({ choices: PrintChoicesSchema }),
    response: PrintPreviewSchema.nullable()
  },
  'print:run': {
    request: z.object({ choices: PrintChoicesSchema, pageCount: z.number().int() }),
    response: z.object({ ok: z.boolean(), reason: z.string() })
  },
  'print:savePdf': {
    request: z.object({ choices: PrintChoicesSchema }),
    response: z.object({ ok: z.boolean(), path: z.string() })
  },

  /** The sponsored creative the notice surface is showing. */
  'sponsor:currentNotice': { request: z.void(), response: SponsoredTileSchema.nullable() },

  /** The text of the notice currently showing, read by the overlay on mount. */
  'notice:current': {
    request: z.void(),
    response: z.object({
      message: z.string(),
      tone: z.enum(['info', 'warn']),
      /**
       * One optional thing the notice offers to do.
       *
       * Deliberately a *download address* rather than a general command: a
       * notice that could run arbitrary commands would be a second, unaudited
       * action channel next to the AI executor's carefully enumerated one. The
       * only thing a notice offers today is fetching a file the user copied,
       * and the shape says so.
       */
      action: z
        // `downloadUrl` enqueues; `openUrl` opens a tab. Exactly one is set —
        // a notice that offers an action has to say which action, and the two
        // are different enough that a single field would have to be sniffed.
        .object({
          label: z.string(),
          downloadUrl: z.string().default(''),
          openUrl: z.string().default('')
        })
        .nullable()
    })
  },
  'shortcuts:list': {
    request: z.void(),
    response: z.array(
      z.object({
        /** Derived from the menu path; what a remapping is stored against. */
        id: z.string(),
        group: z.string(),
        label: z.string(),
        /** What it is bound to now. */
        accelerator: z.string(),
        /** What it ships bound to, so a row can say it has been changed. */
        defaultAccelerator: z.string()
      })
    )
  },
  /**
   * Rebinds one command, or clears the binding when `accelerator` is null.
   *
   * Validated in the main process rather than trusted from the renderer: an
   * accelerator Electron cannot parse makes `setApplicationMenu` throw, and that
   * throw would take the whole menu — every shortcut in the browser — with it.
   */
  'shortcuts:set': {
    request: z.object({ id: z.string().min(1), accelerator: z.string().nullable() }),
    response: z.object({
      ok: z.boolean(),
      /** Why it was refused, for the settings row to show. */
      problem: z.string().nullable(),
      /** Commands now sharing keys with this one. Advisory: the binding is still made. */
      conflictsWith: z.array(z.string())
    })
  },
  /** Puts every shortcut back to what it shipped as. */
  'shortcuts:resetAll': { request: z.void(), response: z.void() },

  /**
   * Reserves a strip on the right for a side panel, shrinking the page view.
   * The renderer owns the panel's width, so it is the one that reports it.
   */
  'layout:setRightPanelWidth': {
    request: z.object({ width: z.number().int().min(0).max(1200) }),
    response: z.void()
  },
  /**
   * Chrome height changes when a row appears or disappears — the find bar being
   * the first case. The page view insets to match, so the bar never covers the
   * matches it is highlighting.
   */
  'layout:setChromeHeight': {
    request: z.object({ height: z.number().int().min(0).max(600) }),
    response: z.void()
  },
  /**
   * Tells main whether the chrome is currently hidden by auto-hide.
   *
   * Main needs to know because it, not the renderer, has to watch for the
   * pointer coming back: the top edge of the window is the OS resize border and
   * never reaches web content at all.
   */
  'layout:setChromeHidden': {
    request: z.object({
      /** Whether the auto-hide setting is on at all. */
      active: z.boolean(),
      /** Whether the chrome is collapsed right now. */
      hidden: z.boolean()
    }),
    response: z.void()
  },

  // Tab mutations return the resulting snapshot as well as broadcasting it. The
  // caller then updates from its own response instead of racing the broadcast.
  /**
   * Every tab in the window, including workspaces the user is not looking at.
   *
   * Distinct from `tabs:list`, which is scoped to the active workspace because
   * that is what the tab strip draws. Tab search is the one surface that has to
   * see across the whole window — a tab you cannot find because it is in another
   * workspace is exactly the tab you opened tab search to find.
   */
  'tabs:listAll': { request: z.void(), response: TabsSnapshotSchema },
  'tabs:list': { request: z.void(), response: TabsSnapshotSchema },
  'tabs:create': {
    request: z.object({
      url: z.string().optional(),
      /** Open without stealing focus from the current tab. */
      background: z.boolean().default(false),
      /** Insert directly after this tab instead of at the end. */
      afterTabId: z.string().optional()
    }),
    response: TabsSnapshotSchema
  },
  'tabs:close': { request: TabIdSchema, response: TabsSnapshotSchema },
  /**
   * Puts a second tab beside the active one, or ends the split with null.
   *
   * The response carries `splitTabId` so the caller can tell a refusal from a
   * success — the window may be too narrow for two usable panes, in which case
   * nothing changes and the UI must not pretend otherwise.
   */
  'tabs:setSplit': {
    request: z.object({ tabId: z.string().nullable() }),
    response: TabsSnapshotSchema
  },
  /**
   * Opens or closes split view, choosing the partner itself.
   *
   * In main rather than in the palette, because the interesting half is what
   * happens when it **cannot**: a tab showing the new tab page has no page view
   * to composite, so asking for one laid out a split and immediately dropped it
   * while the caller discarded the result. Pressing the shortcut did visibly
   * nothing. Refusals are explained here, where `showNotice` lives.
   */
  'tabs:toggleSplit': { request: z.void(), response: TabsSnapshotSchema },
  'tabs:setSplitFraction': {
    request: z.object({ fraction: z.number() }),
    response: TabsSnapshotSchema
  },
  'tabs:setSplitOrientation': {
    request: z.object({ orientation: z.enum(['vertical', 'horizontal']) }),
    response: TabsSnapshotSchema
  },
  'tabs:swapSplit': { request: z.void(), response: TabsSnapshotSchema },

  /**
   * Tab groups — coloured runs inside one workspace.
   *
   * `tabs:deleteGroup` removes the label and leaves every tab open;
   * `tabs:closeGroup` closes the tabs. They are one careless click apart and
   * only one is recoverable, so they are separate channels with separate names
   * rather than one call with a flag.
   */
  'tabs:createGroup': {
    request: z.object({
      tabIds: z.array(z.string()).min(1),
      name: z.string().max(60).default(''),
      color: TabGroupSchema.shape.color.default('blue')
    }),
    response: TabsSnapshotSchema
  },
  'tabs:updateGroup': {
    request: z.object({
      id: z.string(),
      name: z.string().max(60).optional(),
      color: TabGroupSchema.shape.color.optional(),
      collapsed: z.boolean().optional()
    }),
    response: TabsSnapshotSchema
  },
  'tabs:deleteGroup': { request: z.object({ id: z.string() }), response: TabsSnapshotSchema },
  'tabs:closeGroup': { request: z.object({ id: z.string() }), response: TabsSnapshotSchema },
  'tabs:setTabGroup': {
    request: z.object({ tabId: z.string(), groupId: z.string().nullable() }),
    response: TabsSnapshotSchema
  },
  'tabs:activate': { request: TabIdSchema, response: TabsSnapshotSchema },
  'tabs:reorder': {
    request: z.object({ tabId: z.string(), toIndex: z.number().int().min(0) }),
    response: TabsSnapshotSchema
  },
  'tabs:setPinned': {
    request: z.object({ tabId: z.string(), pinned: z.boolean() }),
    response: TabsSnapshotSchema
  },
  'tabs:setMuted': {
    request: z.object({ tabId: z.string(), muted: z.boolean() }),
    response: TabsSnapshotSchema
  },
  'tabs:duplicate': { request: TabIdSchema, response: TabsSnapshotSchema },
  'tabs:reopenClosed': { request: z.void(), response: TabsSnapshotSchema },
  /**
   * Closes a set of tabs identified as duplicates, and counts them as such.
   *
   * One call rather than N `tabs:close` calls, for two reasons. The count the
   * weekly report shows is the number of tabs a *tidy-up* closed, which main
   * cannot infer from an ordinary close; and closing twelve tabs one message at
   * a time emits twelve snapshots to every privileged view.
   *
   * It is still just closing tabs — each one lands in the recently-closed list
   * exactly as if it had been closed by hand, so Ctrl+Shift+T undoes this.
   */
  'tabs:closeDuplicates': {
    request: z.object({ tabIds: z.array(z.string()).max(200) }),
    response: z.object({ closed: z.number().int() })
  },
  'tabs:recentlyClosed': { request: z.void(), response: z.array(ClosedTabSchema) },
  'tabs:reopenClosedAt': {
    request: z.object({ id: z.number().int() }),
    response: TabsSnapshotSchema
  },
  /** Duplicate-tab detection: returns an already-open tab for this URL, if any. */
  'tabs:findByUrl': {
    request: z.object({ url: z.string() }),
    response: TabSchema.nullable()
  },
  'tabs:moveToWorkspace': {
    request: z.object({ tabId: z.string(), workspaceId: z.string() }),
    // `reloaded` reports whether the move crossed a session boundary and so
    // signed the tab out. The UI must have warned before calling, and uses this
    // to confirm what actually happened.
    response: z.object({ reloaded: z.boolean() })
  },

  'workspaces:list': { request: z.void(), response: WorkspacesSnapshotSchema },
  'workspaces:create': {
    request: z.object({
      name: z.string().min(1).max(60),
      icon: z.enum(WORKSPACE_ICONS).default(DEFAULT_WORKSPACE_ICON),
      color: z.enum(WORKSPACE_COLORS).default('slate'),
      /** Fixed at creation — see WorkspaceSchema. */
      isolated: z.boolean().default(false)
    }),
    response: WorkspacesSnapshotSchema
  },
  'workspaces:update': {
    request: z.object({
      id: z.string(),
      name: z.string().min(1).max(60).optional(),
      icon: z.string().max(8).optional(),
      color: z.enum(WORKSPACE_COLORS).optional(),
      notes: z.string().optional()
    }),
    response: WorkspacesSnapshotSchema
  },
  'workspaces:delete': {
    request: z.object({ id: z.string() }),
    response: WorkspacesSnapshotSchema
  },
  'workspaces:activate': {
    request: z.object({ id: z.string() }),
    response: WorkspacesSnapshotSchema
  },
  /** Copies a workspace's settings and its open tab URLs into a new workspace. */
  'workspaces:duplicate': {
    request: z.object({ id: z.string(), isolated: z.boolean().default(false) }),
    response: WorkspacesSnapshotSchema
  },

  'nav:navigate': {
    // Raw omnibox text. The main process decides URL vs search query, so the
    // rule lives in one tested place rather than in the renderer.
    request: z.object({ tabId: z.string(), input: z.string() }),
    response: z.object({ url: z.string() })
  },
  'nav:goBack': { request: TabIdSchema, response: z.void() },
  'nav:goForward': { request: TabIdSchema, response: z.void() },
  'nav:reload': {
    request: z.object({ tabId: z.string(), ignoreCache: z.boolean().default(false) }),
    response: z.void()
  },
  'nav:stop': { request: TabIdSchema, response: z.void() },

  'menu:showTabContextMenu': { request: TabIdSchema, response: z.void() },
  'view:setZoomLevel': {
    // Chromium's usable range; each step is a factor of 1.2.
    request: z.object({ tabId: z.string(), level: z.number().min(-5).max(5) }),
    response: z.object({ level: z.number() })
  },
  'view:find': {
    request: z.object({
      tabId: z.string(),
      text: z.string(),
      forward: z.boolean().default(true),
      findNext: z.boolean().default(false)
    }),
    response: z.void()
  },
  'view:stopFind': {
    request: z.object({ tabId: z.string(), keepSelection: z.boolean().default(false) }),
    response: z.void()
  },
  'view:print': { request: TabIdSchema, response: z.void() },
  'window:toggleFullScreen': { request: z.void(), response: z.object({ fullScreen: z.boolean() }) },
  /**
   * Hands the tab's page to the system default browser.
   *
   * Takes a tab id, not a URL. The main process reads the address from the tab
   * itself, so a compromised renderer cannot use this to make the OS open an
   * arbitrary link.
   */
  'shell:openTabExternally': {
    request: TabIdSchema,
    response: z.object({ opened: z.boolean() })
  },

  'performance:snapshot': { request: z.void(), response: PerformanceSnapshotSchema },
  'performance:setMode': {
    request: z.object({ mode: z.enum(['off', 'balanced', 'aggressive']) }),
    response: PerformanceSnapshotSchema
  },
  'performance:setProtected': {
    request: z.object({ tabId: z.string(), isProtected: z.boolean() }),
    response: PerformanceSnapshotSchema
  },
  // `applied: false` means a guard refused. The UI then shows which blocker
  // applied rather than silently doing nothing.
  'performance:hibernate': {
    request: z.object({ tabId: z.string() }),
    response: z.object({ applied: z.boolean() })
  },
  'performance:freeze': {
    request: z.object({ tabId: z.string() }),
    response: z.object({ applied: z.boolean() })
  },
  'performance:restore': {
    request: z.object({ tabId: z.string() }),
    response: z.void()
  },
  'performance:applyRecommendation': {
    request: z.object({ tabIds: z.array(z.string()) }),
    response: z.object({ applied: z.number().int() })
  },

  'permissions:respond': {
    request: z.object({ requestId: z.string(), policy: PermissionPolicySchema }),
    response: z.void()
  },
  /**
   * Pulled by the overlay on mount — the prompt that caused the overlay to load
   * was announced before its document existed to hear it.
   */
  'permissions:getPending': { request: z.void(), response: PermissionRequestSchema.nullable() },
  'permissions:list': { request: z.void(), response: z.array(PermissionGrantSchema) },
  'permissions:revoke': {
    request: z.object({
      partition: z.string(),
      origin: z.string(),
      kind: PermissionKindSchema,
      /**
       * Chromium caches some grants renderer-side, so revoking mid-page is not
       * always immediate. Reloading is the only way to be certain — offered
       * rather than forced, since it discards page state.
       */
      reloadTabs: z.boolean().default(false)
    }),
    response: z.array(PermissionGrantSchema)
  },
  'permissions:events': {
    request: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
    response: z.array(PermissionEventSchema)
  },
  'permissions:clearEvents': { request: z.void(), response: z.void() },

  'snapshots:list': { request: z.void(), response: z.array(SnapshotSchema) },
  'snapshots:detail': {
    request: z.object({ id: z.number().int() }),
    response: SnapshotDetailSchema.nullable()
  },
  'snapshots:create': {
    request: z.object({ label: z.string().min(1).max(120) }),
    response: z.array(SnapshotSchema)
  },
  'snapshots:restore': {
    request: z.object({
      id: z.number().int(),
      /** Put every tab into one new workspace instead of their original ones. */
      intoNewWorkspace: z.boolean().default(false)
    }),
    response: z.object({
      restored: z.number().int(),
      /** How many windows were opened, so the UI can say so rather than surprise. */
      windows: z.number().int(),
      /**
       * The tabs that arrived, so the caller can offer an undo.
       *
       * Restoring destroys nothing — it adds — but it can put twenty tabs in
       * front of somebody who meant to look before they leapt, and closing
       * exactly what appeared is the only honest way back. Only this window's
       * ids: an undo button should not reach into a window it does not own.
       */
      tabIds: z.array(z.string()).default([])
    })
  },
  /** Restore a single tab out of a snapshot, by its index within it. */
  'snapshots:restoreTab': {
    request: z.object({ id: z.number().int(), tabIndex: z.number().int().min(0) }),
    response: z.object({
      restored: z.number().int(),
      tabIds: z.array(z.string()).default([])
    })
  },
  /**
   * Renames a restore point.
   *
   * Automatic snapshots are named after the moment they were taken, and a name
   * is what turns one of those into something worth keeping. Renaming changes
   * nothing about what it holds.
   */
  'snapshots:rename': {
    request: z.object({ id: z.number().int(), label: z.string().min(1).max(120) }),
    response: z.array(SnapshotSchema)
  },
  'snapshots:delete': {
    request: z.object({ id: z.number().int() }),
    response: z.array(SnapshotSchema)
  },

  'memory:search': {
    request: z.object({
      query: z.string(),
      limit: z.number().int().min(1).max(100).default(30)
    }),
    // The parsed query comes back too, so the UI can show which time window it
    // understood rather than leaving the user guessing why results are filtered.
    response: z.object({
      results: z.array(MemoryResultSchema),
      parsed: ParsedQuerySchema
    })
  },
  'memory:stats': { request: z.void(), response: MemoryStatsSchema },
  'memory:forget': { request: z.object({ url: z.string() }), response: MemoryStatsSchema },
  'memory:clear': { request: z.void(), response: MemoryStatsSchema },
  'memory:semanticStatus': { request: z.void(), response: SemanticStatusSchema },
  /**
   * Turns the local embedding layer on or off.
   *
   * Returns immediately with the status after the switch — `preparing` on the
   * first enable, not `ready`. Loading the model can take minutes on a slow
   * connection, and an IPC call that blocks until it finishes would hang the
   * settings panel; progress arrives on `memory:semanticChanged`.
   */
  'memory:setSemanticEnabled': {
    request: z.object({ enabled: z.boolean() }),
    response: SemanticStatusSchema
  },

  'ai:status': { request: z.void(), response: AiStatusSchema },
  /** The key is write-only across IPC; it is never sent back to the renderer. */
  'ai:setApiKey': {
    request: z.object({ key: z.string() }),
    response: z.object({ stored: z.boolean(), reason: z.string().nullable() })
  },
  /** Exactly what would be sent, shown before anything is sent. */
  'ai:egressPreview': {
    request: z.object({ includePageContent: z.boolean().default(false) }),
    response: EgressPreviewSchema
  },
  'ai:propose': {
    request: z.object({
      request: z.string().min(1).max(500),
      includePageContent: z.boolean().default(false)
    }),
    response: z.object({
      plan: ActionPlanSchema.nullable(),
      error: z.string().nullable()
    })
  },
  'ai:approve': {
    request: z.object({ planId: z.string() }),
    response: z.object({
      applied: z.number().int(),
      skipped: z.number().int(),
      messages: z.array(z.string()),
      canUndo: z.boolean()
    })
  },
  'ai:cancel': { request: z.object({ planId: z.string() }), response: z.void() },
  'ai:undo': { request: z.void(), response: z.object({ undone: z.boolean() }) },
  'ai:activity': {
    request: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    response: z.array(AiActivitySchema)
  },

  'blocking:status': {
    request: z.object({ tabId: z.string() }),
    response: BlockingStatusSchema
  },
  /**
   * Everything Slash Shield blocked since startup, across every tab.
   *
   * Separate from `blocking:status`, which needs a tab id — the new tab page is
   * an internal page with no page view, so it has no tab whose status to ask
   * for, and the figure it wants is the window's rather than one page's.
   */
  'blocking:sessionTotals': { request: z.void(), response: ShieldCountsSchema },
  /**
   * Every security signal the browser already holds about one tab's site.
   *
   * Assembled from the engines that own each fact — the shield, Redirect X-Ray,
   * the permission store, the download list — rather than recomputed here. This
   * channel unifies; it decides nothing, and a signal missing from it means the
   * engine behind it had nothing to say rather than that it was not asked.
   */
  'trust:report': {
    request: z.object({ tabId: z.string() }),
    response: TrustSignalsSchema
  },
  /**
   * Reads what several open pages say about themselves, so they can be compared.
   *
   * Runs a script in each page's own world, on this click only — nothing is
   * read on load or on a timer, nothing is fetched, and no model is consulted.
   * A tab that cannot be read comes back in `unreadable` with the reason rather
   * than being silently dropped, because a comparison missing a column somebody
   * selected looks like a fault.
   */
  'compare:tabs': {
    request: z.object({ tabIds: z.array(z.string()).min(2).max(4) }),
    response: z.object({
      facts: z.array(PageFactsSchema),
      unreadable: z.array(
        z.object({ tabId: z.string(), title: z.string(), reason: z.string() })
      )
    })
  },
  /**
   * A week of what the browser actually did, for the protection report.
   *
   * Counts, never hosts. The table behind this holds no URL and no tab id — a
   * record of which sites blocked what would be a second history of everywhere
   * somebody has been, which is the thing the blocker exists to prevent.
   */
  'protection:week': {
    request: z.void(),
    response: z.object({
      days: z.array(ProtectionDaySchema),
      permissionsDenied: z.number().int()
    })
  },
  /** Forgets the week's counts. The report is the only thing that reads them. */
  'protection:clear': { request: z.void(), response: z.void() },
  /**
   * The last self-check of the page-world ad strip.
   *
   * Exists because the strip stopped running entirely and nothing in the
   * product could notice: the protocol replied, the log said it was installed,
   * and this screen said the blocker was on. Asking the page is the only check
   * that separates "installed" from "running".
   */
  'shield:verification': { request: z.void(), response: ShieldVerificationSchema },
  /**
   * Assembles a report about an advert that got through, and copies it.
   *
   * This is the loop, not a nicety. Brave's rules stay current because a
   * community notices a site changing shape and a filter update follows within
   * hours; a solo-maintained blocker has no such community, so the next best
   * thing is making the one person who *did* see the advert able to say so in
   * one click, with the facts that are actually needed to write a rule.
   *
   * Deliberately a **clipboard report, not an upload**. Principle 2: nothing
   * leaves the machine unless the user sent it. The page address is the whole
   * point of the report and is exactly the sort of thing this browser does not
   * transmit on its own, so it goes to the clipboard and the person decides.
   */
  'shield:reportLeak': {
    request: z.object({ tabId: z.string() }),
    response: z.object({ report: z.string() })
  },
  'blocking:setSiteAllowed': {
    request: z.object({ host: z.string(), allowed: z.boolean(), tabId: z.string() }),
    response: BlockingStatusSchema
  },

  /**
   * Lets a held popup through.
   *
   * Takes the *id* of something Slash Shield already blocked, never a URL. Main
   * looks the URL up in its own held record, so a compromised chrome view cannot
   * turn this into "open any address I name".
   */
  'shield:releasePopup': {
    request: z.object({ id: z.string(), tabId: z.string() }),
    response: BlockingStatusSchema
  },
  'shield:allowPopupsHere': {
    request: z.object({ tabId: z.string() }),
    response: BlockingStatusSchema
  },
  'shield:setSiteLock': {
    request: z.object({ tabId: z.string(), locked: z.boolean() }),
    response: BlockingStatusSchema
  },
  'shield:setMode': {
    request: z.object({ mode: z.enum(['standard', 'strict']), tabId: z.string() }),
    response: BlockingStatusSchema
  },
  'shield:clearActivity': {
    request: z.object({ tabId: z.string() }),
    response: BlockingStatusSchema
  },

  /**
   * Extracts the active tab as an article and opens the reader over it.
   *
   * Returns the result as well as showing it, so the toolbar can say "this is
   * not an article" in place rather than opening an empty reader.
   */
  /**
   * Reading list — a queue, not a reference library.
   *
   * Separate from bookmarks on purpose: a bookmark is something you intend to
   * keep, a reading-list entry something you intend to clear. Every mutation
   * returns the whole list, so the panel never has to guess at the new order.
   */
  'reading:list': { request: z.void(), response: z.array(ReadingItemSchema) },
  'reading:add': {
    request: z.object({
      url: z.string(),
      title: z.string().default(''),
      faviconUrl: z.string().nullable().default(null)
    }),
    response: z.array(ReadingItemSchema)
  },
  'reading:remove': {
    request: z.object({ id: z.number().int() }),
    response: z.array(ReadingItemSchema)
  },
  'reading:setRead': {
    request: z.object({ id: z.number().int(), read: z.boolean() }),
    response: z.array(ReadingItemSchema)
  },
  'reading:clearRead': { request: z.void(), response: z.array(ReadingItemSchema) },

  /**
   * Saved sign-ins.
   *
   * Note what is absent: there is no channel that returns a password. The vault
   * decrypts only inside the main process, and the value goes into the page
   * through Chromium's input pipeline. `VaultStatus` has no field a password
   * could travel in, so a future handler cannot leak one by accident.
   */
  'vault:status': { request: z.void(), response: VaultStatusSchema },
  'vault:save': {
    request: z.object({
      host: z.string(),
      username: z.string().default(''),
      password: z.string()
    }),
    /** The failure reason, or null on success. */
    response: z.object({ error: z.string().nullable(), status: VaultStatusSchema })
  },
  'vault:remove': { request: z.object({ id: z.number().int() }), response: VaultStatusSchema },
  'vault:clearAll': { request: z.void(), response: VaultStatusSchema },
  /** What Slash can offer to fill on this tab right now. */
  'vault:formForTab': {
    request: TabIdSchema,
    response: z.object({
      form: LoginFormSchema,
      host: z.string(),
      matches: VaultStatusSchema.shape.logins
    })
  },
  'vault:fill': {
    request: z.object({ tabId: z.string(), loginId: z.number().int() }),
    response: z.object({ error: z.string().nullable() })
  },

  /**
   * Sponsored tiles on the start page.
   *
   * `sponsor:click` takes only an id and opens the URL from our own cached
   * record — the renderer never names a destination, so a compromised chrome
   * view cannot turn this into "open any URL I like".
   */
  'sponsor:status': { request: z.void(), response: SponsorStatusSchema },
  'sponsor:impression': { request: z.object({ tileId: z.string() }), response: z.void() },
  'sponsor:click': { request: z.object({ tileId: z.string() }), response: z.void() },
  'sponsor:refresh': { request: z.void(), response: SponsorStatusSchema },
  'sponsor:clear': { request: z.void(), response: SponsorStatusSchema },

  /**
   * The user's own start-page background.
   *
   * Read from disk in main and returned as a data URL. The renderer never gets
   * a filesystem path to load, which is what keeps the start page from being a
   * way to read arbitrary files.
   */
  'newtab:pickBackground': { request: z.void(), response: z.string().nullable() },
  'newtab:backgroundImage': { request: z.void(), response: z.string().nullable() },

  /**
   * Unpacked extensions. There is no install-from-store channel because
   * Electron has no install flow to expose.
   */
  'extensions:status': { request: z.void(), response: ExtensionsStatusSchema },
  /** Opens a folder picker; returns the failure reason, or null. */
  'extensions:add': { request: z.void(), response: z.object({ error: z.string().nullable() }) },
  'extensions:remove': { request: z.object({ id: z.string() }), response: ExtensionsStatusSchema },

  'reader:open': { request: z.void(), response: ReaderResultSchema },
  /** Pulled by the overlay document once it has mounted. */
  'reader:get': { request: z.void(), response: ReaderResultSchema },
  /**
   * Translates the article currently in the reader.
   *
   * **Sends the page's text to the configured AI provider**, so it is gated on
   * `aiMayReadPageContent` — the same switch that governs every other way page
   * content reaches a provider, rather than a second one to find and reason
   * about. Refuses with a reason instead of failing silently.
   */
  'reader:translate': {
    request: z.object({ language: z.string().default('') }),
    response: z.union([
      z.object({
        ok: z.literal(true),
        title: z.string(),
        blocks: z.array(z.string())
      }),
      z.object({ ok: z.literal(false), reason: z.string() })
    ])
  },
  /** Whether translation could run at all, so the button can say why not. */
  'reader:translateAvailable': { request: z.void(), response: z.boolean() },

  'import:sources': { request: z.void(), response: z.array(ImportSourceSchema) },
  /**
   * Takes a source **id**, never a filesystem path.
   *
   * Main resolves the id against its own freshly-scanned list, so a compromised
   * chrome view cannot turn this into "read any file I name and put it in the
   * database".
   */
  'import:run': {
    request: z.object({
      sourceId: z.string(),
      bookmarks: z.boolean().default(true),
      history: z.boolean().default(true)
    }),
    response: ImportSummarySchema
  },

  'downloadEngine:list': { request: z.void(), response: z.array(EngineDownloadSchema) },
  /**
   * Starts a managed download.
   *
   * Takes a URL because this is invoked from our own chrome in response to a
   * user action — a link's context menu, or the media panel. It is not reachable
   * from web content: the sender allowlist blocks page views outright.
   */
  'downloadEngine:enqueue': {
    request: z.object({
      url: z.string().url(),
      priority: DownloadPrioritySchema.default('normal'),
      /** Epoch ms to hold the download until, for off-peak transfers. */
      startAfter: z.number().int().nullable().default(null)
    }),
    response: z.object({ id: z.string() })
  },
  'downloadEngine:pause': { request: z.object({ id: z.string() }), response: z.void() },
  'downloadEngine:resume': { request: z.object({ id: z.string() }), response: z.void() },
  'downloadEngine:cancel': { request: z.object({ id: z.string() }), response: z.void() },
  'downloadEngine:remove': { request: z.object({ id: z.string() }), response: z.void() },
  'downloadEngine:setPriority': {
    request: z.object({ id: z.string(), priority: DownloadPrioritySchema }),
    response: z.void()
  },
  /**
   * Follows this site's links and collects the files it publishes.
   *
   * Bounded before it starts — the depth and page count are clamped in main by
   * `clampOptions`, so a renderer cannot ask for a bigger crawl than the limits
   * allow. Same-origin is not a parameter at all.
   */
  'guardian:grabSite': {
    request: z.object({
      depth: z.number().int().min(0).max(3).default(1),
      maxPages: z.number().int().min(1).max(200).default(50),
      extensions: z.array(z.string().max(8)).max(20).default([]),
      respectRobots: z.boolean().default(true)
    }),
    response: SiteGrabSchema
  },
  'downloadEngine:clearFinished': { request: z.void(), response: z.void() },
  /**
   * Opens or reveals a finished *engine* download.
   *
   * Separate from `downloads:openFile` because the two engines keep separate id
   * namespaces — Chromium's `dl-…` and the queue's UUIDs — and routing an
   * engine id to the Chromium lookup found nothing and did nothing, silently.
   */
  'downloadEngine:openFile': { request: z.object({ id: z.string() }), response: z.void() },
  'downloadEngine:showInFolder': { request: z.object({ id: z.string() }), response: z.void() },
  /**
   * Where downloads are going, and a way to change it for the next one.
   *
   * Read separately from `settings` so the picker can show the folder without
   * pulling the whole settings object into a modal that needs one string.
   */
  'downloadEngine:destination': {
    request: z.void(),
    response: z.object({ directory: z.string(), asksEveryTime: z.boolean() })
  },
  /**
   * Opens a folder chooser and returns what was picked.
   *
   * Null when the user cancelled, which is a normal outcome and not an error —
   * the caller keeps the folder it had. The **path never comes from the
   * renderer**: it is whatever the OS dialog returned, so a compromised chrome
   * view cannot name a directory of its own.
   */
  'downloadEngine:chooseFolder': {
    request: z.void(),
    response: z.object({ directory: z.string().nullable() })
  },
  /** Releases a scheduled download from its hold. */
  /**
   * Expands a pattern like `file[1-50].jpg` without fetching anything.
   *
   * Separate from enqueueing on purpose: the user sees exactly what is about to
   * be requested, and how many requests that is, before a single one is made.
   */
  'downloadEngine:previewBatch': {
    request: z.object({ pattern: z.string().max(2048) }),
    response: z.object({
      urls: z.array(z.string()),
      note: z.string(),
      error: z.boolean()
    })
  },
  'downloadEngine:enqueueBatch': {
    request: z.object({
      pattern: z.string().max(2048),
      queue: z.string().max(64).optional()
    }),
    response: z.object({ started: z.number().int(), note: z.string() })
  },
  /** Moves a download to another named queue. */
  'downloadEngine:setQueue': {
    request: z.object({ id: z.string(), queue: z.string().max(64) }),
    response: z.void()
  },
  /**
   * Points a paused download at a fresh address after the old one expired.
   *
   * Answers with what happened rather than a bare boolean, because "kept the
   * 2.1 GB already downloaded" and "started again" are both successes and the
   * user needs to know which.
   */
  'downloadEngine:refreshUrl': {
    request: z.object({ id: z.string(), url: z.string().url() }),
    response: z.object({ ok: z.boolean(), reason: z.string() })
  },
  /** Calls off a pending sleep or shutdown. */
  'downloadEngine:cancelCompletionAction': {
    request: z.void(),
    response: z.void()
  },
  'downloadEngine:startNow': { request: z.object({ id: z.string() }), response: z.void() },

  /**
   * Inventories and classifies the download links on the active page.
   *
   * Scanned on demand. Doing this on every page load would walk 400 anchors of
   * every page anyone visits to answer a question almost nobody asks.
   */
  /**
   * Analyses the window's tabs locally — no AI, no network.
   *
   * On demand rather than continuously: clustering every tab set change would
   * burn CPU to keep a panel warm that is usually closed.
   */
  /**
   * Cleans the active tab's page.
   *
   * Injected CSS only, held in the live document — reloading restores the page
   * exactly, which is why this can never corrupt a site.
   */
  /**
   * Reads the active page and reports what it declares about itself.
   *
   * Local heuristics over markup — no AI and no network, which the panel states
   * so findings are not over-trusted as a model's reading of the page.
   */
  'insight:analyse': { request: z.void(), response: PageInsightSchema },

  /** The active mission, past missions, and any suggestion for this page. */
  'mission:status': { request: z.void(), response: MissionStatusSchema },
  /** Starts a mission, ending any other. Exactly one is active at a time. */
  'mission:start': {
    request: z.object({ goal: z.string().min(1).max(200) }),
    response: MissionStatusSchema
  },
  'mission:complete': { request: z.void(), response: MissionStatusSchema },
  'mission:discard': { request: z.object({ id: z.number().int() }), response: MissionStatusSchema },
  'mission:setNotes': {
    request: z.object({ id: z.number().int(), notes: z.string().max(20000) }),
    response: MissionStatusSchema
  },
  /** Puts the current page in the for-later pile rather than blocking it. */
  'mission:saveForLater': { request: z.void(), response: MissionStatusSchema },
  'mission:removeItem': {
    request: z.object({ itemId: z.number().int() }),
    response: MissionStatusSchema
  },

  /** Watched pages and their changes. */
  'watch:status': { request: z.void(), response: WatchStatusSchema },
  /** Starts or stops watching the active tab's page. */
  'watch:toggle': { request: z.void(), response: WatchStatusSchema },
  'watch:remove': { request: z.object({ url: z.string() }), response: WatchStatusSchema },
  'watch:markSeen': { request: z.void(), response: WatchStatusSchema },

  /** Update state. Reports `no-channel` when no feed is configured. */
  /**
   * What this machine is, and what Slash decided to do about it.
   *
   * Reported rather than inferred in the renderer: `os.totalmem()` and the
   * processor count are main-process facts, and the chrome should draw what
   * was decided rather than make a second, possibly different decision.
   */
  'system:hardware': {
    request: z.void(),
    response: z.object({
      tier: z.enum(['low', 'modest', 'capable']),
      effects: z.enum(['full', 'reduced']),
      suggestedMode: z.enum(['off', 'balanced', 'aggressive']),
      downloadConnections: z.number(),
      embeddingsAdvisable: z.boolean(),
      reasons: z.array(z.string()),
      /** The switch, so the panel can show both the setting and the effect. */
      enabled: z.boolean(),
      said: z.string()
    })
  },

  'updates:status': { request: z.void(), response: UpdateStatusSchema },
  /**
   * Checks the configured feed. Never downloads or installs a package — this
   * build is unsigned, so it cannot verify one came from us.
   */
  'updates:check': { request: z.void(), response: UpdateStatusSchema },

  // --- sync -----------------------------------------------------------------

  // --- profiles --------------------------------------------------------------

  /**
   * Configuration the publisher of this build controls.
   *
   * Always answers, immediately, from cache or defaults — the start page must
   * never wait on a network call to draw itself.
   */
  'config:remote': { request: z.void(), response: RemoteConfigSchema },

  'profiles:list': {
    request: z.void(),
    response: z.object({
      activeId: z.string(),
      profiles: z.array(
        z.object({ id: z.string(), name: z.string(), createdAt: z.number() })
      )
    })
  },
  'profiles:create': { request: z.object({ name: z.string() }), response: z.string() },
  'profiles:rename': {
    request: z.object({ id: z.string(), name: z.string() }),
    response: z.void()
  },
  'profiles:delete': {
    request: z.object({ id: z.string() }),
    response: z.object({ ok: z.boolean(), reason: z.string() })
  },
  /**
   * Restarts into another profile.
   *
   * A relaunch rather than a swap: the database, session partitions and caches
   * are all open on the current profile by the time anybody clicks this, and
   * `app.setPath('userData')` is only honoured before any of that happened.
   */
  'profiles:switch': { request: z.object({ id: z.string() }), response: z.void() },

  // --- saved addresses -------------------------------------------------------

  'addresses:list': { request: z.void(), response: z.array(SavedAddressSchema) },
  'addresses:save': {
    request: SavedAddressSchema.partial({ id: true }),
    response: SavedAddressSchema
  },
  'addresses:delete': { request: z.object({ id: z.number().int() }), response: z.void() },
  /** Which address fields the page in front offers, so the UI can offer to fill them. */
  'addresses:fieldsHere': { request: z.void(), response: z.array(z.string()) },
  /**
   * Types a saved address into the page.
   *
   * The value never crosses into the renderer or the page's preload — main sends
   * "focus this field" and then `insertText`. Only an id crosses this boundary.
   */
  'addresses:fill': {
    request: z.object({ id: z.number().int() }),
    response: z.object({ filled: z.number().int() })
  },

  'sync:status': { request: z.void(), response: SyncStatusSchema },
  /**
   * Derives the key from a passphrase and checks it against the account.
   *
   * The passphrase crosses this boundary once and is never stored — not on
   * disk, not in settings, and no key derived from it either. It is the only
   * message in the browser that carries one, which is why it goes no further
   * than `SyncService.unlock`.
   */
  'sync:unlock': {
    request: z.object({ passphrase: z.string() }),
    response: z.object({ ok: z.boolean(), problem: z.string() })
  },
  'sync:lock': { request: z.void(), response: SyncStatusSchema },
  'sync:now': { request: z.void(), response: SyncStatusSchema },
  'sync:reset': { request: z.void(), response: SyncStatusSchema },

  /**
   * Slash Coin.
   *
   * `status` is the only reader, and everything in it is a copy of what the
   * server last said — the browser never computes a balance. `signIn` opens the
   * *system* browser and returns immediately: Google's FedCM is not implemented
   * in Electron, so the sign-in cannot happen in a window here, and the result
   * arrives later over `rewards:changed`.
   */
  'rewards:status': { request: z.void(), response: RewardsStatusSchema },
  'rewards:signIn': { request: z.void(), response: RewardsSignInResultSchema },
  /**
   * Finishes a sign-in from an address the user pasted, when the loopback never
   * received the code. The escape hatch every desktop OAuth tool carries.
   */
  'rewards:completeSignIn': {
    request: z.object({ pasted: z.string().max(4096) }),
    response: RewardsSignInResultSchema
  },
  'rewards:signOut': { request: z.void(), response: RewardsStatusSchema },
  'rewards:refresh': { request: z.void(), response: RewardsStatusSchema },
  /**
   * The collector's own details. Null when signed out, rather than an empty
   * profile -- "not signed in" and "signed in and never filled it in" are
   * different screens.
   */
  /**
   * Advertising from inside the browser, on the same account as Slash Coin.
   *
   * Everything that decides anything is server-side: row-level security scopes
   * the company and the campaigns to the caller, and a trigger sets the price
   * from the rate card. These three carry a form to it and bring the answer
   * back.
   */
  'advertiser:state': { request: z.void(), response: AdvertiserStateSchema },
  'advertiser:saveCompany': { request: CompanyInputSchema, response: AdvertiserResultSchema },
  'advertiser:submitCampaign': { request: CampaignInputSchema, response: AdvertiserResultSchema },
  /** Withdraws a campaign that is still waiting for review or payment. */
  'advertiser:cancelCampaign': {
    request: z.object({ id: z.string() }),
    response: AdvertiserResultSchema
  },

  'rewards:profile': { request: z.void(), response: CoinProfileSchema.nullable() },
  'rewards:saveProfile': {
    request: CoinProfileInputSchema,
    response: CoinProfileResultSchema
  },

  /**
   * Asking to be paid, and proving the wallet.
   *
   * Every rule lives in the database functions these call: the minimum, the
   * one-request-at-a-time rule, and the deduction that stops a balance being
   * claimed twice. The signature is stored, never verified here -- a client
   * that verified its own wallet would be proving nothing.
   */
  'rewards:requestPayout': {
    request: z.object({ coins: z.number().positive() }),
    response: z.object({ ok: z.boolean(), problem: z.string() })
  },
  'rewards:walletChallenge': {
    request: z.void(),
    response: z.object({ ok: z.boolean(), problem: z.string(), challenge: z.string() })
  },
  'rewards:submitWalletSignature': {
    request: z.object({ signature: z.string().max(400) }),
    response: z.object({ ok: z.boolean(), problem: z.string() })
  },
  /**
   * Downloads and installs the available update, then relaunches.
   *
   * Refuses on an unsigned build. The refusal is returned rather than thrown so
   * the UI can say why, which is the whole point of offering the button at all.
   */
  'updates:install': {
    request: z.void(),
    response: z.object({ ok: z.boolean(), detail: z.string() })
  },

  /**
   * Fetches the package and verifies it against the checksum the feed
   * published, without installing anything.
   *
   * Separate from `updates:install` because they are separate decisions: one
   * spends bandwidth, the other closes the browser and runs an installer.
   */
  'updates:download': {
    request: z.void(),
    response: z.object({ ok: z.boolean(), detail: z.string() })
  },

  /**
   * Local crash record. Dumps stay on the machine — there is no upload server,
   * and the payload says so rather than leaving the user to assume.
   */
  'crashes:report': { request: z.void(), response: CrashReportSchema },
  'crashes:clear': { request: z.void(), response: CrashReportSchema },
  'crashes:openFolder': { request: z.void(), response: z.void() },

  /** Which AI providers exist, and which are connected. Never returns a key. */
  'aiHub:status': { request: z.void(), response: AiHubStatusSchema },
  /**
   * Stores a provider's credentials.
   *
   * The key travels renderer → main once and is immediately encrypted with the
   * OS keychain. There is deliberately no channel that returns one, so a
   * compromised renderer cannot read back what was stored.
   */
  'aiHub:connect': {
    request: z.object({
      provider: AiProviderIdSchema,
      apiKey: z.string().max(400).optional(),
      model: z.string().max(120).optional(),
      baseUrl: z.string().max(300).optional()
    }),
    response: z.object({ error: z.string().nullable(), status: AiHubStatusSchema })
  },
  'aiHub:disconnect': {
    request: z.object({ provider: AiProviderIdSchema }),
    response: AiHubStatusSchema
  },
  /**
   * What would be sent, and to whom, before anything is.
   *
   * Asking three providers means the same text reaches three companies, each
   * with its own retention policy — so the recipients are named and confirmed
   * per request rather than behind a setting enabled once and forgotten.
   */
  'aiHub:comparePreview': {
    request: z.object({
      question: z.string().min(1).max(4000),
      providers: z.array(AiProviderIdSchema).min(1).max(4)
    }),
    response: ComparePreviewSchema
  },
  /** Sends the question to each named provider. Failures are isolated per row. */
  'aiHub:compare': {
    request: z.object({
      question: z.string().min(1).max(4000),
      providers: z.array(AiProviderIdSchema).min(1).max(4)
    }),
    response: AiComparisonSchema
  },
  'aiHub:setDefault': {
    request: z.object({ provider: AiProviderIdSchema }),
    response: z.object({ error: z.string().nullable(), status: AiHubStatusSchema })
  },

  /** Recorded main-frame redirect chains for this window, newest first. */
  'redirects:chains': { request: z.void(), response: z.array(RedirectChainSchema) },
  'redirects:clear': { request: z.void(), response: z.void() },
  /**
   * Adds a domain to the user's own block rules.
   *
   * Takes a host rather than a rule expression: this is invoked from a chain the
   * user is looking at, and letting the renderer author arbitrary filter syntax
   * would be a wider surface than the feature needs.
   */
  'redirects:blockDomain': {
    request: z.object({ host: z.string().min(1).max(253) }),
    response: z.object({ blocked: z.array(z.string()) })
  },

  'cleanup:apply': {
    request: z.object({ mode: CleanupModeSchema.optional() }),
    response: CleanupResultSchema
  },
  'cleanup:restore': { request: z.void(), response: CleanupStatusSchema },
  'cleanup:status': { request: z.void(), response: CleanupStatusSchema },
  /** Turns cleanup off for the current site, or back on. */
  'cleanup:setDisabledForHost': {
    request: z.object({ disabled: z.boolean() }),
    response: CleanupStatusSchema
  },

  'tabBrain:analyse': { request: z.void(), response: TabAnalysisSchema },
  /**
   * Closes tabs the user selected from the suggestions.
   *
   * Explicit ids rather than "close everything you suggested", so what the user
   * saw and what happens cannot drift apart between render and click.
   */
  'tabBrain:closeTabs': {
    request: z.object({ tabIds: z.array(z.string()).max(200) }),
    response: TabAnalysisSchema
  },
  /** Moves a suggested group into a workspace of its own. */
  'tabBrain:groupIntoWorkspace': {
    request: z.object({ tabIds: z.array(z.string()).max(200), name: z.string().min(1).max(60) }),
    response: z.object({ workspaceId: z.string(), moved: z.number().int() })
  },

  'guardian:scanDownloads': { request: z.void(), response: DownloadScanSchema },
  'guardian:scanMedia': { request: z.void(), response: MediaScanSchema },
  'media:detected': { request: z.void(), response: z.object({ count: z.number().int() }) },
  /**
   * What the floating chip should say, or null when there is nothing to offer.
   *
   * One candidate, not a list. The chip is a single-click affordance over a
   * playing video — anybody who wants to choose between four files opens the
   * panel, and a menu floating over the page they are watching is worse than
   * the button they wanted.
   */
  'media:offer': {
    request: z.void(),
    response: z
      .object({
        url: z.string(),
        filename: z.string(),
        sizeText: z.string(),
        /** How many others there are, so the chip can point at the panel. */
        others: z.number().int()
      })
      .nullable()
  },
  'media:openPicker': { request: z.void(), response: z.void() },
  /**
   * Everything the active page can be downloaded as.
   *
   * Two sources merged: what the network observer saw, and what the page itself
   * lists. The second is the only one that finds anything on YouTube, where
   * media arrives as byte ranges of a transport format rather than as a file.
   */
  'media:options': {
    request: z.void(),
    response: z.object({
      /** For the filenames, and the picker's heading. */
      title: z.string(),
      /** Empty means nothing downloadable — `note` says why. */
      choices: z.array(
        z.object({
          url: z.string(),
          label: z.string(),
          sizeText: z.string(),
          /** False means it is one half of a pair: video without sound, or sound alone. */
          complete: z.boolean(),
          hasVideo: z.boolean(),
          hasAudio: z.boolean()
        })
      ),
      note: z.string().nullable()
    })
  },
  /**
   * Qualities the page's own player says it can switch to.
   *
   * Separate from `media:options` because they answer different questions.
   * Options is "what can be downloaded right now"; this is "what could be, if
   * the player were asked to fetch it". On a site that publishes no addresses —
   * YouTube, measured at 30 formats with none — the second list is much longer
   * than the first, and the gap between them is the entire "why is only 360p
   * offered" complaint.
   */
  'media:qualities': {
    request: z.void(),
    response: z.object({
      available: z.boolean(),
      levels: z.array(
        z.object({ level: z.string(), label: z.string(), current: z.boolean() })
      ),
      note: z.string().nullable()
    })
  },
  /**
   * Asks the page's player to switch quality, then waits for it to fetch some.
   *
   * This calls the site's **own public player API** — the same call its quality
   * menu makes — so nothing is worked around and the effect is exactly as if
   * the person had chosen it by hand. It changes what they are watching, which
   * is why it only ever runs from an explicit choice.
   */
  'media:requestQuality': {
    request: z.object({ level: z.string().max(32) }),
    response: z.object({
      ok: z.boolean(),
      now: z.string(),
      /** How many downloadable items exist after the switch. */
      found: z.number().int(),
      note: z.string()
    })
  },
  /**
   * What a user-installed yt-dlp says this page is available as.
   *
   * Separate from `media:options` because the two have different provenance,
   * and the UI has to be able to say which is which. Options is what the
   * browser itself observed; this is what an external tool reports.
   */
  /** Whether a yt-dlp is available, and whether Slash installed it. */
  'external:status': {
    request: z.void(),
    response: z.object({
      installed: z.boolean(),
      /** True when this is the copy Slash fetched, which it can also update. */
      managed: z.boolean(),
      path: z.string().nullable(),
      version: z.string().nullable()
    })
  },
  /**
   * Fetches the current yt-dlp from its official releases into userData.
   *
   * Deliberately not bundled with the installer: yt-dlp ships extractor fixes
   * every few weeks, Slash has no auto-update of its own, and a copy frozen
   * into the installer would break within a month with no way to repair it.
   */
  'external:install': {
    request: z.void(),
    response: z.object({
      ok: z.boolean(),
      version: z.string().nullable(),
      note: z.string()
    })
  },
  'external:uninstall': {
    request: z.void(),
    response: z.object({ ok: z.boolean(), note: z.string() })
  },
  'media:externalFormats': {
    request: z.void(),
    response: z.object({
      /** False when the tool is off or not installed — `note` says which. */
      available: z.boolean(),
      title: z.string(),
      choices: z.array(
        z.object({
          selector: z.string(),
          label: z.string(),
          ext: z.string(),
          sizeText: z.string()
        })
      ),
      note: z.string().nullable()
    })
  },
  'media:downloadExternal': {
    request: z.object({ selector: z.string().max(200), label: z.string().max(300) }),
    response: z.object({ started: z.boolean(), note: z.string() })
  },
  'media:downloadChoice': {
    request: z.object({
      url: z.string(),
      /**
       * Where to put it, when the user chose a folder in the dialog.
       *
       * Only ever a path this process handed out from a native chooser — the
       * handler checks it against the last one offered rather than trusting the
       * renderer, because a directory from an untrusted sender is a write
       * anywhere on the disk.
       */
      directory: z.string().optional()
    }),
    response: z.object({ ok: z.boolean(), reason: z.string().nullable() })
  },
  'media:dismissOffer': { request: z.void(), response: z.void() },

  /**
   * Docks the AI assistant beside the current page, or undocks it.
   *
   * `ok: false` with a reason rather than silence — the window can simply be
   * too narrow for two usable panes, and a shortcut that appears to do nothing
   * gets reported as broken.
   */
  'assistant:toggle': {
    request: z.void(),
    response: z.object({ ok: z.boolean(), reason: z.string().nullable() })
  },

  /**
   * Whether Slash is the system default browser, and whether to offer.
   *
   * `shouldOffer` is decided in main rather than the renderer because the
   * cadence is a product rule with a record behind it, and a renderer that
   * decides when to nag is a renderer that nags again after every reload.
   */
  'system:defaultBrowser': {
    request: z.void(),
    response: z.object({
      isDefault: z.boolean(),
      shouldOffer: z.boolean(),
      supported: z.boolean()
    })
  },
  /**
   * Opens Windows' Default apps screen.
   *
   * Named for what it does. There is no channel that *makes* Slash the default,
   * because Windows has not allowed that since Windows 8 and a channel called
   * `system:makeDefault` would be a lie in the type system.
   */
  'system:openDefaultBrowserSettings': { request: z.void(), response: z.void() },
  /**
   * Re-reads the association and answers with the fresh status.
   *
   * Separate from `system:defaultBrowser` because that one must answer
   * instantly from cache — it is called while the start page paints — and this
   * one shells out to the registry.
   */
  'system:refreshDefaultBrowser': {
    request: z.void(),
    response: z.object({
      isDefault: z.boolean(),
      shouldOffer: z.boolean(),
      supported: z.boolean()
    })
  },
  'system:dismissDefaultBrowser': {
    /** `forever` is "don't ask again"; otherwise the offer is merely counted. */
    request: z.object({ forever: z.boolean() }),
    response: z.void()
  },

  'history:search': {
    request: HistoryQuerySchema,
    response: z.array(HistoryEntrySchema)
  },
  'history:delete': {
    request: z.object({ ids: z.array(z.number().int()) }),
    response: z.void()
  },
  'history:clear': {
    /** Epoch ms; omit to clear everything. */
    request: z.object({ since: z.number().optional() }),
    response: z.void()
  },

  'bookmarks:list': { request: z.void(), response: z.array(BookmarkSchema) },
  'bookmarks:create': {
    request: z.object({
      url: z.string(),
      title: z.string(),
      faviconUrl: z.string().nullable().default(null),
      parentId: z.number().int().nullable().default(null),
      isFolder: z.boolean().default(false)
    }),
    response: BookmarkSchema
  },
  'bookmarks:update': {
    request: z.object({
      id: z.number().int(),
      title: z.string().optional(),
      url: z.string().optional(),
      parentId: z.number().int().nullable().optional(),
      sortOrder: z.number().int().optional()
    }),
    response: BookmarkSchema
  },
  'bookmarks:delete': { request: z.object({ id: z.number().int() }), response: z.void() },
  'bookmarks:findByUrl': {
    request: z.object({ url: z.string() }),
    response: BookmarkSchema.nullable()
  },

  'downloads:list': { request: z.void(), response: z.array(DownloadItemSchema) },
  'downloads:pause': { request: z.object({ id: z.string() }), response: z.void() },
  'downloads:resume': { request: z.object({ id: z.string() }), response: z.void() },
  'downloads:cancel': { request: z.object({ id: z.string() }), response: z.void() },
  'downloads:openFile': { request: z.object({ id: z.string() }), response: z.void() },
  'downloads:showInFolder': { request: z.object({ id: z.string() }), response: z.void() },
  'downloads:remove': { request: z.object({ id: z.string() }), response: z.void() },
  'downloads:clearCompleted': { request: z.void(), response: z.void() }

  // Exhaustive both ways: a channel in channels.ts with no contract here fails
  // the build, and a contract here for an unlisted channel fails it too.
} as const satisfies Record<InvokeChannel, ChannelContract>

export type InvokeRequest<C extends InvokeChannel> = z.infer<(typeof invokeContracts)[C]['request']>
export type InvokeResponse<C extends InvokeChannel> = z.infer<
  (typeof invokeContracts)[C]['response']
>

// --- event channels (main -> renderer) --------------------------------------


export const eventContracts = {
  'settings:changed': SettingsSchema,
  'overlay:stateChanged': OverlayStateSchema,
  'tabs:snapshot': TabsSnapshotSchema,
  'downloads:changed': z.array(DownloadItemSchema),
  'media:found': z.object({ count: z.number().int() }),
  'history:changed': z.object({}),
  /**
   * A new batch of creatives arrived, or the cache was emptied.
   *
   * The start page read sponsor status once on mount with an empty
   * dependency array, and it is drawn by the chrome document — which mounts
   * at launch, before any batch has been fetched. So the banner and the
   * background never appeared until the next restart, on a placement
   * somebody had paid for.
   */
  'sponsor:changed': z.object({}),
  'bookmarks:changed': z.array(BookmarkSchema),
  /** Sync state moved: unlocked, synced, failed, or reset. */
  'sync:changed': SyncStatusSchema,
  'rewards:changed': RewardsStatusSchema,
  'updates:changed': UpdateStatusSchema,
  /** The publisher's remote configuration changed since the last fetch. */
  'config:changed': RemoteConfigSchema,
  'workspaces:snapshot': WorkspacesSnapshotSchema,
  'performance:changed': PerformanceSnapshotSchema,
  'omnibox:state': OmniboxStateSchema,
  'permissions:prompt': PermissionRequestSchema.nullable(),
  'permissions:changed': z.array(PermissionGrantSchema),
  'memory:semanticChanged': SemanticStatusSchema,
  'redirects:chain': RedirectChainSchema,
  'watch:changed': z.object({ url: z.string(), change: PageChangeSchema }),
  'mission:suggestion': z.object({ url: z.string(), suggestion: z.string() }),
  'downloadEngine:changed': z.array(EngineDownloadSchema),
  'ui:command': UiCommandSchema,
  'shield:popupBlocked': PopupBlockedSchema,
  'shield:navigationBlocked': NavigationNoticeSchema,
  'shield:navigationWarned': NavigationNoticeSchema,
  'shield:verificationChanged': ShieldVerificationSchema
} as const satisfies Record<EventChannel, z.ZodType>

export type EventPayload<C extends EventChannel> = z.infer<(typeof eventContracts)[C]>
