import { z } from 'zod'

/**
 * Lifecycle state of a tab's underlying renderer.
 *
 * `live` and `hibernated` are the only two Phase 1 produces. The rest of the
 * Phase 3 ladder (RECENT/BACKGROUND/IDLE/FROZEN) is *priority*, tracked
 * separately — this field is strictly about whether a WebContentsView currently
 * exists, because that is the thing which changes what the UI must render.
 */
export const TabStatusSchema = z.enum([
  /** A WebContentsView exists and is rendering. */
  'live',
  /** No view exists. URL/title/history are retained; activating rebuilds it. */
  'hibernated',
  /** The renderer process died. Shows a sad-tab with a reload action. */
  'crashed'
])
export type TabStatus = z.infer<typeof TabStatusSchema>

export const TabErrorSchema = z.object({
  code: z.number().int(),
  description: z.string(),
  url: z.string()
})
export type TabError = z.infer<typeof TabErrorSchema>

/**
 * Everything the renderer knows about a tab.
 *
 * This is a plain serialisable projection — the live `WebContentsView` never
 * crosses IPC. The renderer drives the UI entirely from these snapshots, which is
 * what lets a hibernated tab (no view at all) render identically to a live one.
 */
export const TabSchema = z.object({
  id: z.string(),
  /** Always 'default' in Phase 1; Phase 2 introduces real workspaces. */
  workspaceId: z.string(),
  url: z.string(),
  /** What the omnibox shows while the user is editing, if different from url. */
  title: z.string(),
  faviconUrl: z.string().nullable(),
  isLoading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  isPinned: z.boolean(),
  isAudible: z.boolean(),
  isMuted: z.boolean(),
  /** User-set "Never Sleep". The performance engine must always honour it. */
  isProtected: z.boolean(),
  /** Detached and hidden by the performance engine; process still alive. */
  isFrozen: z.boolean(),
  /** Chromium zoom level. 0 is 100%; each step is a factor of 1.2. */
  zoomLevel: z.number(),
  /** Populated while a find-in-page is running. */
  findResult: z
    .object({ activeMatch: z.number().int(), totalMatches: z.number().int() })
    .nullable(),
  status: TabStatusSchema,
  error: TabErrorSchema.nullable(),
  /** Epoch ms. Drives both the reopen stack and Phase 3's idle calculation. */
  lastActiveAt: z.number(),
  createdAt: z.number()
})
export type Tab = z.infer<typeof TabSchema>

/** The complete tab-strip state. Broadcast as one coalesced snapshot. */
export const TabsSnapshotSchema = z.object({
  tabs: z.array(TabSchema),
  activeTabId: z.string().nullable()
})
export type TabsSnapshot = z.infer<typeof TabsSnapshotSchema>

/**
 * Internal page the chrome renders itself, in the hole normally covered by a
 * page view. Using a sentinel rather than a real `app://` protocol keeps the new
 * tab page inside the privileged chrome document, so it can read bookmarks and
 * history over the existing IPC surface without registering a scheme or granting
 * a page view any privileges.
 */
export const NEW_TAB_URL = 'adaptive://newtab'

export function isInternalUrl(url: string): boolean {
  return url.startsWith('adaptive://')
}
