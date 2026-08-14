import { join } from 'node:path'
import { WebContentsView, type BaseWindow, type Rectangle } from 'electron'
import type { OverlayState } from '@shared/ipc/contracts'
import { VIEW_KIND } from '@shared/constants'
import type { IpcRegistry } from '../ipc/registry'
import { createLogger } from '../logger'
import { rendererEntry } from './rendererEntry'

const log = createLogger('overlay')

/**
 * The transparent surface stacked above page content.
 *
 * This exists because a `WebContentsView` is a native view composited by Chromium
 * above the DOM: the chrome UI physically cannot draw over a web page with CSS
 * `z-index`. Anything that must visually cover a page — command bar, dialogs,
 * permission prompts, context menus — renders here instead.
 *
 * IMPORTANT — hit testing is rectangular, not per-pixel. A transparent overlay
 * swallows every click inside its bounds even where nothing is drawn. So:
 *
 *   - Modal surfaces (command bar, dialogs) take the full content rect. Swallowing
 *     input is exactly the desired behaviour there.
 *   - Non-modal surfaces must pass an explicit `bounds` covering only the pixels
 *     they actually paint, or they will silently make the page unclickable.
 *
 * When hidden the view is removed from the tree entirely rather than only marked
 * invisible, so there is no state in which it can intercept input it should not.
 */
export class OverlayController {
  private view: WebContentsView | null = null
  private attached = false
  private state: OverlayState = { visible: false, surface: 'none' }

  constructor(
    private readonly window: BaseWindow,
    private readonly ipc: IpcRegistry
  ) {}

  create(): WebContentsView {
    if (this.view) return this.view

    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/chrome.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        // Chromium paints an opaque base layer unless the view is told otherwise.
        transparent: true
      }
    })

    // Fully transparent (AARRGGBB). The overlay document must also keep its own
    // html/body backgrounds transparent, or this has no visible effect.
    view.setBackgroundColor('#00000000')

    const entry = rendererEntry('overlay')
    if (entry.kind === 'url') void view.webContents.loadURL(entry.url)
    else void view.webContents.loadFile(entry.path)

    this.ipc.registerPrivilegedView(view.webContents, VIEW_KIND.overlay)
    this.view = view
    log.debug('overlay view created')
    return view
  }

  /**
   * @param bounds Region the overlay may draw in and will capture input within.
   *               Omit for a modal surface spanning the whole content area.
   */
  show(surface: Exclude<OverlayState['surface'], 'none'>, bounds: Rectangle): OverlayState {
    const view = this.create()
    view.setBounds(bounds)

    if (!this.attached) {
      // Re-adding also reorders to topmost, which is what we want: the overlay
      // must sit above every page view added since it was last shown.
      this.window.contentView.addChildView(view)
      this.attached = true
    }
    view.setVisible(true)
    view.webContents.focus()

    this.state = { visible: true, surface }
    log.debug(`overlay shown: ${surface}`)
    return this.state
  }

  hide(): OverlayState {
    if (this.view && this.attached) {
      this.view.setVisible(false)
      this.window.contentView.removeChildView(this.view)
      this.attached = false
    }
    this.state = { visible: false, surface: 'none' }
    log.debug('overlay hidden')
    return this.state
  }

  /** Keeps a visible modal overlay matched to the window as it resizes. */
  relayout(fullBounds: Rectangle): void {
    if (this.view && this.state.visible) this.view.setBounds(fullBounds)
  }

  getState(): OverlayState {
    return this.state
  }

  get webContents() {
    return this.view?.webContents ?? null
  }

  destroy(): void {
    if (!this.view) return
    if (this.attached) this.window.contentView.removeChildView(this.view)
    this.view.webContents.close()
    this.view = null
    this.attached = false
  }
}
