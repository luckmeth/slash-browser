import type { WebContents } from 'electron'
import type { Tab } from './Tab'

export interface TabEventHooks {
  /** Something about the tab changed and the snapshot should be re-broadcast. */
  onChanged: () => void
  /** A main-frame navigation completed — the point at which history is recorded. */
  onNavigated: (tab: Tab, url: string) => void
  /** Title or favicon arrived after navigation; history metadata catches up. */
  onMetadata: (tab: Tab) => void
  /** The renderer process died. */
  onCrashed: (tab: Tab) => void
}

/**
 * Normalises the sprawl of `webContents` events into the small set of state
 * changes the rest of the app cares about.
 *
 * Two things worth knowing:
 *
 *  - Several of these fire for subframes. Recording history or updating the
 *    omnibox from a subframe navigation would make an ad iframe rewrite the
 *    address bar, so main-frame checks are load-bearing, not defensive noise.
 *  - `did-navigate` fires before the document has a title. History therefore
 *    records the URL first and lets `page-title-updated` fill the title in
 *    afterwards, rather than storing an empty one.
 */
export function attachTabEvents(contents: WebContents, tab: Tab, hooks: TabEventHooks): void {
  const syncNavigationState = (): void => {
    tab.patch({
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward()
    })
  }

  contents.on('did-start-loading', () => {
    tab.patch({ isLoading: true, error: null })
    hooks.onChanged()
  })

  contents.on('did-stop-loading', () => {
    tab.patch({ isLoading: false })
    syncNavigationState()
    hooks.onChanged()
  })

  contents.on('did-navigate', (_event, url) => {
    tab.patch({ url, error: null })
    syncNavigationState()
    hooks.onNavigated(tab, url)
    hooks.onChanged()
  })

  // SPA route changes (history.pushState). The URL genuinely changed, so the
  // omnibox and history must follow, but there is no new document load.
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return
    tab.patch({ url })
    syncNavigationState()
    hooks.onNavigated(tab, url)
    hooks.onChanged()
  })

  contents.on('page-title-updated', (_event, title) => {
    tab.patch({ title })
    hooks.onMetadata(tab)
    hooks.onChanged()
  })

  contents.on('page-favicon-updated', (_event, favicons) => {
    const [first] = favicons
    if (!first) return
    tab.patch({ faviconUrl: first })
    hooks.onMetadata(tab)
    hooks.onChanged()
  })

  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which Chromium reports for ordinary user-initiated
    // stops and for redirects. Surfacing it as a failure would flash an error
    // page every time someone hits Stop.
    if (!isMainFrame || errorCode === -3) return
    tab.patch({
      isLoading: false,
      error: { code: errorCode, description: errorDescription, url: validatedURL }
    })
    hooks.onChanged()
  })

  contents.on('media-started-playing', () => {
    tab.patch({ isAudible: contents.isCurrentlyAudible() })
    hooks.onChanged()
  })

  contents.on('media-paused', () => {
    tab.patch({ isAudible: contents.isCurrentlyAudible() })
    hooks.onChanged()
  })

  contents.on('audio-state-changed', (event) => {
    tab.patch({ isAudible: event.audible })
    hooks.onChanged()
  })

  // There is no API to ask whether a page has registered a beforeunload handler,
  // and the preload cannot see the page's own `window` across context isolation.
  // So this is observed rather than predicted: once Chromium tells us a handler
  // tried to block an unload, we know this tab has one and stop sleeping it.
  // A page that has one but has never been asked to unload will not be caught —
  // the unsaved-form-input signal is the reliable guard, this is a supplement.
  contents.on('will-prevent-unload', () => {
    tab.markBeforeUnloadObserved()
    hooks.onChanged()
  })

  contents.on('render-process-gone', (_event, details) => {
    tab.patch({
      status: 'crashed',
      isLoading: false,
      error: { code: -1, description: `Renderer ${details.reason}`, url: tab.snapshot.url }
    })
    hooks.onCrashed(tab)
    hooks.onChanged()
  })
}
