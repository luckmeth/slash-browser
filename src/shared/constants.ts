/** Height of the browser chrome (tab strip + toolbar) in CSS pixels. */
export const CHROME_HEIGHT = 88

/**
 * Width of the workspace switcher rail on the left edge.
 *
 * Shared because the renderer draws the rail and the main process must inset the
 * native page view by exactly the same amount — a mismatch would either clip the
 * page or leave a dead strip beside it.
 */
export const WORKSPACE_RAIL_WIDTH = 56

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

export const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s' }
} as const

export type SearchEngineId = keyof typeof SEARCH_ENGINES
