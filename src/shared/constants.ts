/**
 * Title bar row. Tabs live here, as in every mainstream browser — the window has
 * no OS title bar of its own (`titleBarStyle: 'hidden'`), so this strip *is* the
 * title bar and must contain the draggable region.
 */
export const TITLE_BAR_HEIGHT = 40

/** Navigation toolbar row, directly below the title bar. */
export const TOOLBAR_HEIGHT = 44

/** Total chrome above the page. */
export const CHROME_HEIGHT = TITLE_BAR_HEIGHT + TOOLBAR_HEIGHT

/**
 * Space reserved at the right of the title bar for the native window controls.
 *
 * Windows draws minimise/maximise/close itself via `titleBarOverlay`; the tab
 * strip must not run underneath them or the last tab becomes unclickable. Three
 * buttons at 46px is the standard Windows metric.
 */
export const WINDOW_CONTROLS_WIDTH = 138

/**
 * Gutter between the page and the window edge, so the glass chrome frames it.
 * Matched by the page view's corner radius below.
 */
export const PAGE_INSET = 10

/** Corner radius applied to the native page view. */
export const PAGE_RADIUS = 12

/**
 * Width of the workspace switcher rail on the left edge.
 *
 * Shared because the renderer draws the rail and the main process must inset the
 * native page view by exactly the same amount — a mismatch would either clip the
 * page or leave a dead strip beside it.
 */
export const WORKSPACE_RAIL_WIDTH = 56

/**
 * Width of the vertical tab column, when the strip is on the left.
 *
 * Wide enough for a readable title, which is the entire reason to move the
 * strip: horizontal tabs become unreadable somewhere past fifteen, and a
 * vertical list simply keeps scrolling. Main insets the native page view by
 * this plus the workspace rail — a mismatch would clip the page or leave a dead
 * strip beside it.
 */
export const VERTICAL_TAB_STRIP_WIDTH = 208

/** How many closed tabs the reopen stack remembers. */
export const CLOSED_TAB_STACK_LIMIT = 25

/**
 * Frame names assigned to our privileged views. `ipc/registry.ts` allowlists
 * senders by matching the WebContents id against the registry of views it was
 * told about — these names exist for logging and debugging.
 */
export const VIEW_KIND = {
  chrome: 'chrome',
  overlay: 'overlay',
  page: 'page'
} as const

export type ViewKind = (typeof VIEW_KIND)[keyof typeof VIEW_KIND]

// Google first, because insertion order is what the Settings dropdown renders
// and what an unbound <select> falls back to displaying. A list whose first
// entry is not the default engine shows the wrong engine as selected the moment
// the bound value is missing for a frame — which reads as "my setting was
// ignored" and is indistinguishable from it.
export const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s' }
} as const

export type SearchEngineId = keyof typeof SEARCH_ENGINES
