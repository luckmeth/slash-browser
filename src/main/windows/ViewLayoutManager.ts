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

  compute(contentWidth: number, contentHeight: number): LayoutRects {
    const width = Math.max(0, Math.round(contentWidth))
    const height = Math.max(0, Math.round(contentHeight))
    const full: Rectangle = { x: 0, y: 0, width, height }

    // Clamp so a very short or narrow window degrades to a zero-size page area
    // rather than a negative one, which Chromium rejects.
    const pageY = Math.min(this.chromeHeight, height)
    const pageX = Math.min(this.sidebarWidth, width)
    const available = Math.max(0, width - pageX)

    return {
      chrome: full,
      full,
      page: {
        x: pageX,
        y: pageY,
        width: Math.max(0, available - Math.min(this.rightPanelWidth, available)),
        height: Math.max(0, height - pageY)
      }
    }
  }
}
