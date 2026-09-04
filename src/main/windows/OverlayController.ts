import { join } from 'node:path'
import { shell, WebContentsView, type BaseWindow, type Rectangle, type WebContents } from 'electron'
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
  private modal = true
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

    this.harden(view.webContents)
    this.ipc.registerPrivilegedView(view.webContents, VIEW_KIND.overlay)
    this.view = view
    log.debug('overlay view created')
    return view
  }

  /**
   * The overlay holds the privileged bridge, so it must never leave its own
   * document.
   *
   * The chrome view has had this guard since it was written; the overlay did
   * not, and it is the surface that renders *page-derived* material — reader
   * text, a media offer, a permission prompt naming a site, a context menu
   * built from a link. None of those is supposed to be able to navigate
   * anything, and none of them can today. But "no current path does this" is a
   * statement about today's code, and the cost of being wrong is a remote
   * origin holding `window.browser`: every privileged channel in the
   * application, from the same process that renders whatever a page supplied.
   *
   * So the rule is stated rather than relied upon. A navigation away from the
   * overlay's own document is refused and logged loudly, because in normal
   * operation it never happens — an entry in the log means either a bug or an
   * attempt.
   */
  private harden(contents: WebContents): void {
    contents.on('will-navigate', (event, url) => {
      const devServer = process.env['ELECTRON_RENDERER_URL']
      if ((devServer && url.startsWith(devServer)) || url.startsWith('file://')) return
      event.preventDefault()
      log.error(`blocked navigation of the overlay view to ${url}`)
    })

    // Same for a frame inside it, which `will-navigate` does not cover.
    contents.on('will-frame-navigate', (event) => {
      const url = event.url
      const devServer = process.env['ELECTRON_RENDERER_URL']
      if ((devServer && url.startsWith(devServer)) || url.startsWith('file://')) return
      event.preventDefault()
      log.error(`blocked frame navigation inside the overlay to ${url}`)
    })

    // A link in the overlay opens in the real browser rather than replacing a
    // privileged view, and anything that is not a web address opens nothing.
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
      else log.warn(`refused to open ${url.slice(0, 40)} from the overlay`)
      return { action: 'deny' }
    })
  }

  /**
   * @param bounds  Region the overlay may draw in and will capture input within.
   * @param options `modal` keeps the overlay matched to the window on resize;
   *                a bounded surface such as the omnibox dropdown keeps its own
   *                rect. `takeFocus` must be false for surfaces that appear
   *                *while the user is typing elsewhere* — focusing the overlay
   *                would pull the caret out of the omnibox mid-keystroke.
   */
  show(
    surface: Exclude<OverlayState['surface'], 'none'>,
    bounds: Rectangle,
    options: { modal?: boolean; takeFocus?: boolean } = {}
  ): OverlayState {
    const { modal = surface !== 'command-bar', takeFocus = surface !== 'command-bar' } = options
    const view = this.create()
    view.setBounds(bounds)
    this.modal = modal

    if (!this.attached) {
      // Re-adding also reorders to topmost, which is what we want: the overlay
      // must sit above every page view added since it was last shown.
      this.window.contentView.addChildView(view)
      this.attached = true
    }
    view.setVisible(true)
    if (takeFocus) view.webContents.focus()

    this.state = { visible: true, surface }
    log.debug(`overlay shown: ${surface} (modal=${modal})`)
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

  /**
   * Keeps a visible **modal** overlay matched to the window as it resizes.
   *
   * A bounded surface is skipped: stretching the omnibox dropdown to the full
   * window on resize would swallow every click on the page behind it.
   */
  relayout(fullBounds: Rectangle): void {
    if (this.view && this.state.visible && this.modal) this.view.setBounds(fullBounds)
  }

  getState(): OverlayState {
    return this.state
  }

  /** Which surface is up, so a passive one can refuse to steal the overlay. */
  get current(): OverlayState {
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
