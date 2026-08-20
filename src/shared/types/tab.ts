import { z } from 'zod'

/** A rectangle in window content coordinates (DIP), as `View.setBounds` uses. */
const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
})

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
  activeTabId: z.string().nullable(),
  /**
   * The tab showing in the second pane, or null when split view is off.
   *
   * Deliberately separate from `activeTabId`: split view shows two pages but
   * there is still exactly one *active* tab, which is what the omnibox, the
   * find bar and every per-tab control follow.
   */
  splitTabId: z.string().nullable().default(null),
  /** Where the divider sits, as a fraction of the content area. */
  splitFraction: z.number().default(0.5),
  splitOrientation: z.enum(['vertical', 'horizontal']).default('vertical'),
  /** False when the window is too small to hold two usable panes. */
  canSplit: z.boolean().default(true),
  /**
   * Where to draw the drag handle, in window content coordinates.
   *
   * Published rather than recomputed in the renderer because the panes are
   * native views positioned by the main process: a second copy of the layout
   * arithmetic in React would drift from the real gutter the moment either
   * side changed, and the handle would sit next to the seam instead of on it.
   * `content` is the hole being divided, which is what turns a pointer position
   * back into a fraction.
   */
  splitGeometry: z
    .object({
      divider: RectSchema,
      content: RectSchema
    })
    .nullable()
    .default(null)
})
export type TabsSnapshot = z.infer<typeof TabsSnapshotSchema>

/**
 * Internal page the chrome renders itself, in the hole normally covered by a
 * page view. Using a sentinel rather than a real `app://` protocol keeps the new
 * tab page inside the privileged chrome document, so it can read bookmarks and
 * history over the existing IPC surface without registering a scheme or granting
 * a page view any privileges.
 */
export const NEW_TAB_URL = 'slash://newtab'

/**
 * Both schemes are recognised: the browser was renamed, and restore points and
 * history written before that still hold `adaptive://` URLs. Dropping the old
 * prefix would make those tabs look like real web pages and try to navigate to
 * a scheme nothing can load.
 */
export function isInternalUrl(url: string): boolean {
  return url.startsWith('slash://') || url.startsWith('adaptive://')
}
