import type { Rectangle } from 'electron'
import { CHROME_HEIGHT } from '@shared/constants'

export interface LayoutRects {
  /** Browser chrome. Full content area — it owns the toolbar, and later the sidebar. */
  readonly chrome: Rectangle
  /** Where a web page is drawn: the hole the chrome leaves for content. */
  readonly page: Rectangle
  /** Full content area, for modal overlay surfaces. */
  readonly full: Rectangle
}

/**
 * Single source of truth for view geometry.
 *
 * The chrome view spans the whole content area rather than just a top strip, and
 * page views are stacked *above* it covering the content hole. That ordering is
 * what lets the React UI own the full window layout — toolbar now, workspace
 * sidebar in Phase 2 — without adding a native view per UI region.
 *
 * All values are DIP relative to the window content area, which is the coordinate
 * space `View.setBounds` expects.
 */
export class ViewLayoutManager {
  private chromeHeight: number = CHROME_HEIGHT
  private sidebarWidth = 0
  private rightPanelWidth = 0

  setChromeHeight(px: number): void {
    this.chromeHeight = Math.max(0, Math.round(px))
  }

  /** Left rail — the workspace switcher, from Phase 2. */
  setSidebarWidth(px: number): void {
    this.sidebarWidth = Math.max(0, Math.round(px))
  }

  /**
   * Right panel width — history, bookmarks, downloads, settings.
   *
   * These inset the page rather than floating over it. A CSS drawer in the chrome
   * document would be drawn *underneath* the page view, since that view is a
   * native layer composited above the DOM. Making the panel a real inset means
   * the page is never obscured and stays fully interactive beside it.
   */
  setRightPanelWidth(px: number): void {
    this.rightPanelWidth = Math.max(0, Math.round(px))
  }

  /**
   * Gutter between the page view and the window edge.
   *
   * The page is opaque native content. Without a gutter it fills every pixel
   * below the toolbar, so the only glass anyone ever sees is a couple of thin
   * bars — which is why the window did not read as glass at all. Insetting the
   * page turns the chrome into a visible frame around it.
   */
  setPageInset(px: number): void {
    this.pageInset = Math.max(0, Math.round(px))
  }

  private pageInset = 0
  private pageFullscreen = false

  /**
   * A page has entered HTML5 fullscreen — a video, a game, a slide deck.
   *
   * The page view is composited *above* the chrome view, so giving it the whole
   * content rect covers the toolbar and tab strip completely. That is the whole
   * mechanism: without it the page merely fills its usual hole and the browser
   * chrome stays visible around it, which is what "fullscreen" looked like
   * before — a video boxed inside a browser.
   */
  setPageFullscreen(on: boolean): void {
    this.pageFullscreen = on
  }

  get isPageFullscreen(): boolean {
    return this.pageFullscreen
  }

  compute(contentWidth: number, contentHeight: number): LayoutRects {
    const width = Math.max(0, Math.round(contentWidth))
    const height = Math.max(0, Math.round(contentHeight))
    const full: Rectangle = { x: 0, y: 0, width, height }

    // Clamp so a very short or narrow window degrades to a zero-size page area
    // rather than a negative one, which Chromium rejects.
    // Fullscreen wins over every inset: no gutter, no sidebar, no panel. A
    // side panel left open would otherwise carve a strip out of a fullscreen
    // video.
    if (this.pageFullscreen) {
      return { chrome: full, full, page: full }
    }

    const pageY = Math.min(this.chromeHeight, height)
    const pageX = Math.min(this.sidebarWidth, width)
    const available = Math.max(0, width - pageX)
    const rawWidth = Math.max(0, available - Math.min(this.rightPanelWidth, available))
    const rawHeight = Math.max(0, height - pageY)

    // The gutter is dropped entirely when the window is too small for it, rather
    // than eating into a page area that is already cramped.
    const inset = rawWidth > this.pageInset * 4 && rawHeight > this.pageInset * 4 ? this.pageInset : 0

    return {
      chrome: full,
      full,
      page: {
        x: pageX + inset,
        y: pageY,
        width: Math.max(0, rawWidth - inset * 2),
        height: Math.max(0, rawHeight - inset)
      }
    }
  }
}
