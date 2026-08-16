import { shell, dialog, type WebContents, type BaseWindow } from 'electron'
import { createLogger } from '../logger'

const log = createLogger('nav')

/** Schemes a page view may navigate to itself. */
const IN_APP_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:', 'data:', 'blob:'])

/**
 * Schemes that must never be navigated to, and must never be handed to the OS.
 *
 * `javascript:` in particular would execute in the current document's context.
 */
const NEVER = new Set(['javascript:', 'vbscript:'])

export interface NavigationGuardHooks {
  /** A page asked to open a URL in a new window/tab. */
  openInNewTab: (url: string, background: boolean) => void
  /** Owning window, used to parent the external-protocol confirmation dialog. */
  window: BaseWindow
  /**
   * Slash Shield's popup verdict, or null when the guard is not installed.
   *
   * Consulted here rather than in a handler of its own because Electron allows
   * exactly one `setWindowOpenHandler` per WebContents — a second registration
   * silently replaces the first, which would mean whichever module loaded last
   * quietly won.
   */
  shouldAllowPopup?: (url: string, disposition: string) => boolean
}

/**
 * Installs navigation policy on a page view's webContents.
 *
 * Two distinct jobs:
 *
 *  1. `window.open` and target=_blank become real tabs rather than detached
 *     BrowserWindows. Chromium would otherwise hand us a popup window with no
 *     tab strip and no chrome.
 *  2. Non-web schemes are routed to the OS *only after the user confirms*. This
 *     is the boundary where a web page can otherwise cause an arbitrary local
 *     application to launch, so it is never automatic.
 */
export function installNavigationGuards(contents: WebContents, hooks: NavigationGuardHooks): void {
  contents.setWindowOpenHandler(({ url, disposition }) => {
    const scheme = schemeOf(url)

    if (scheme && NEVER.has(scheme)) {
      log.warn(`blocked window.open to ${scheme}`)
      return { action: 'deny' }
    }

    if (scheme && !IN_APP_SCHEMES.has(scheme)) {
      void confirmExternal(url, hooks.window)
      return { action: 'deny' }
    }

    // Slash Shield gets the last word on whether this window was asked for. It
    // holds what it blocks and surfaces it, so a wrong call is recoverable
    // rather than looking like a dead link.
    if (hooks.shouldAllowPopup && !hooks.shouldAllowPopup(url, disposition)) {
      return { action: 'deny' }
    }

    hooks.openInNewTab(url, disposition === 'background-tab')
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    const scheme = schemeOf(url)
    if (!scheme) return

    if (NEVER.has(scheme)) {
      event.preventDefault()
      log.warn(`blocked navigation to ${scheme}`)
      return
    }

    if (!IN_APP_SCHEMES.has(scheme)) {
      // mailto:, tel:, vscode:, steam: ... Chromium cannot render these; handing
      // them to the OS is the correct behaviour, but only with consent.
      event.preventDefault()
      void confirmExternal(url, hooks.window)
    }
  })
}

async function confirmExternal(url: string, window: BaseWindow): Promise<void> {
  const scheme = schemeOf(url) ?? 'unknown'

  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: ['Open', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Open in another application?',
    message: `This page wants to open a ${scheme.replace(':', '')} link outside the browser.`,
    // Show the full target. Truncated middles hide the part that matters, but an
    // unbounded string could push the buttons off-screen.
    detail: url.length > 300 ? `${url.slice(0, 300)}…` : url,
    noLink: true
  })

  if (response === 0) {
    log.info(`opening external: ${scheme}`)
    await shell.openExternal(url)
  }
}

function schemeOf(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*:)/i.exec(url)
  return match?.[1]?.toLowerCase() ?? null
}
