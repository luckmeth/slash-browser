import { z } from 'zod'
import { SettingsSchema } from '../types/settings'
import { TabsSnapshotSchema, TabSchema } from '../types/tab'
import { WorkspacesSnapshotSchema, WORKSPACE_COLORS } from '../types/workspace'
import { PerformanceSnapshotSchema } from '../types/performance'
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
  surface: z.enum(['none', 'spike', 'command-bar', 'dialog', 'permission-prompt'])
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
      icon: z.string().max(8).default('📁'),
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
  'ui:command': UiCommandSchema
} as const satisfies Record<EventChannel, z.ZodType>

export type EventPayload<C extends EventChannel> = z.infer<(typeof eventContracts)[C]>
