import { z } from 'zod'
import { SettingsSchema } from '../types/settings'
import { TabsSnapshotSchema, TabSchema } from '../types/tab'
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
import { DownloadScanSchema, MediaScanSchema } from '../types/downloadGuardian'
import { TabAnalysisSchema } from '../types/tabBrain'
import { CleanupModeSchema, CleanupResultSchema, CleanupStatusSchema } from '../types/cleanup'
import { PageInsightSchema } from '../types/pageInsight'
import { RedirectChainSchema } from '../types/redirectChain'
import { AiHubStatusSchema, AiProviderIdSchema } from '../types/aiHub'
import { CrashReportSchema } from '../types/diagnostics'
import { UpdateStatusSchema } from '../types/updates'
import { PageChangeSchema, WatchStatusSchema } from '../types/watch'
import { MissionStatusSchema } from '../types/mission'
import {
  BlockingStatusSchema,
  PopupBlockedSchema,
  NavigationNoticeSchema
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
    'dialog',
    'permission-prompt',
    'tab-search',
    'reader'
  ])
})
export type OverlayState = z.infer<typeof OverlayStateSchema>

const TabIdSchema = z.object({ tabId: z.string() })

export const HistoryQuerySchema = z.object({
  query: z.string().default(''),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0)
})

// --- invoke channels --------------------------------------------------------

export const invokeContracts = {
  'app:info': { request: z.void(), response: AppInfoSchema },
  'diagnostics:dbStatus': { request: z.void(), response: DbStatusSchema },

  'settings:getAll': { request: z.void(), response: SettingsSchema },
  'settings:update': { request: SettingsSchema.partial(), response: SettingsSchema },

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
    response: z.object({ restored: z.number().int() })
  },
  /** Restore a single tab out of a snapshot, by its index within it. */
  'snapshots:restoreTab': {
    request: z.object({ id: z.number().int(), tabIndex: z.number().int().min(0) }),
    response: z.object({ restored: z.number().int() })
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
  'reader:open': { request: z.void(), response: ReaderResultSchema },
  /** Pulled by the overlay document once it has mounted. */
  'reader:get': { request: z.void(), response: ReaderResultSchema },

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
  'downloadEngine:clearFinished': { request: z.void(), response: z.void() },
  /** Releases a scheduled download from its hold. */
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
  'updates:status': { request: z.void(), response: UpdateStatusSchema },
  /**
   * Checks the configured feed. Never downloads or installs a package — this
   * build is unsigned, so it cannot verify one came from us.
   */
  'updates:check': { request: z.void(), response: UpdateStatusSchema },

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
    'open-find',
    'open-permissions',
    'open-timemachine',
    'open-memory',
    'open-tabbrain',
    'open-insight',
    'open-redirects',
    'open-mission',
    'open-ai',
    'bookmark-current-tab',
    'close-panel'
  ])
})
export type UiCommand = z.infer<typeof UiCommandSchema>

export const eventContracts = {
  'settings:changed': SettingsSchema,
  'overlay:stateChanged': OverlayStateSchema,
  'tabs:snapshot': TabsSnapshotSchema,
  'downloads:changed': z.array(DownloadItemSchema),
  'history:changed': z.object({}),
  'bookmarks:changed': z.array(BookmarkSchema),
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
  'shield:navigationWarned': NavigationNoticeSchema
} as const satisfies Record<EventChannel, z.ZodType>

export type EventPayload<C extends EventChannel> = z.infer<(typeof eventContracts)[C]>
