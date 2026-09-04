import { z } from 'zod'
import { TabGroupSchema } from './tabGroup'

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
  /** Which coloured run this tab belongs to, or null when it is loose. */
  groupId: z.string().nullable().default(null),
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
  /** Groups in the active workspace, in creation order. */
  groups: z.array(TabGroupSchema).default([]),
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
 * Settings, as a full page rather than a 380px side panel.
 *
 * Seventeen groups of settings in a narrow scroll is a list, not a screen, and
 * it was the least usable part of the browser. Chrome and Brave both make this
 * a page for the same reason. It rides the internal-page mechanism the new tab
 * page already uses: no view is attached, and the chrome document fills the
 * content hole.
 */
export const SETTINGS_URL = 'slash://settings'

/**
 * What advertising on Slash costs and how to buy it.
 *
 * An internal page rather than a link to a marketing site, because a company
 * that has just noticed the card on the start page should be able to read the
 * rates without leaving the browser or handing over an email address first.
 * The request itself goes to the operator's portal at the end.
 */
export const ADVERTISE_URL = 'slash://advertise'

/**
 * Slash Coin: the balance, what is accruing, and the countdown.
 *
 * A page rather than a panel because it is read occasionally and at length -
 * the same reasoning as Settings - and because it carries wording about what
 * these points are and are not, which needs room to be read rather than a
 * tooltip.
 */
export const REWARDS_URL = 'slash://rewards'

/**
 * The terms, and what is done with personal information.
 *
 * Internal pages rather than links to a website, for two reasons. They are
 * read at the moment somebody is deciding whether to hand over a date of birth
 * and a wallet address, and a link that opens a marketing site is a link most
 * people do not follow. And they must be readable by somebody who is offline
 * or who has not signed in to anything -- terms nobody can reach are terms
 * nobody agreed to.
 */
export const TERMS_URL = 'slash://terms'
export const PRIVACY_URL = 'slash://privacy'

/**
 * Both schemes are recognised: the browser was renamed, and restore points and
 * history written before that still hold `adaptive://` URLs. Dropping the old
 * prefix would make those tabs look like real web pages and try to navigate to
 * a scheme nothing can load.
 */
export function isInternalUrl(url: string): boolean {
  return url.startsWith('slash://') || url.startsWith('adaptive://')
}

/**
 * What to call an internal page in the tab strip.
 *
 * These pages have no document to take a title from, so without this every one
 * of them read as "New tab" — including Settings, which is simply wrong. Kept
 * beside the URLs themselves so adding a page and forgetting its name is one
 * edit rather than two files apart.
 */
export function internalPageTitle(url: string): string | null {
  if (url === SETTINGS_URL) return 'Settings'
  if (url === ADVERTISE_URL) return 'Advertise on Slash'
  if (url === REWARDS_URL) return 'Slash Coin'
  if (url === TERMS_URL) return 'Terms'
  if (url === PRIVACY_URL) return 'Privacy'
  if (url === NEW_TAB_URL) return 'New tab'
  return isInternalUrl(url) ? 'Slash' : null
}
