import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import { createLogger } from '../logger'

const log = createLogger('SLASH_NEWTAB_CAPTURE')

/**
 * A picture of the start page.
 *
 * Written because a UI change shipped on reasoning alone once already: the
 * renderer warm-up made every restored tab open to a black window, and the ten
 * seconds it would have taken to look at the running browser were never spent.
 * Typecheck, lint and 1,600 unit tests all passed on that build.
 *
 * The start page is the screen seen most often and the one carrying paid
 * placements, so "does it still look right" is a question worth being able to
 * answer in one command rather than by installing a release.
 *
 * `capturePage()` on the **chrome view**, following `motionProbe`: the start
 * page is drawn by the chrome document in the content hole, not by a page view,
 * so capturing a tab's contents would photograph an empty rectangle. The
 * desktop capturer is also avoided — it takes hundreds of milliseconds to set
 * up, which is long enough for the entrance animations to have finished.
 */
export async function runNewTabCapture(
  window: BrowserWindowController,
  target: string
): Promise<void> {
  // `privilegedContents()[0]` is the chrome view, the same route `motionProbe`
  // takes — the controller exposes no direct accessor for it.
  const chrome = window.privilegedContents()[0]
  if (!chrome || chrome.isDestroyed()) {
    log.warn('no chrome view to capture')
    return
  }

  // Optionally somewhere other than the start page, so the advertise and
  // rewards pages can be looked at the same way.
  const targetUrl = process.env['SLASH_CAPTURE_URL']
  if (targetUrl) {
    // `create`, not `navigate`. An internal URL through `navigate` destroys the
    // view and patches the snapshot, and the chrome did not re-render it in
    // time to be photographed; creating the tab is the path every other probe
    // uses and it activates as well.
    window.tabs.create({ url: targetUrl, background: false })
  }

  // Long enough for `animate-rise`, the sponsored batch and the rewards status
  // to have landed. A capture taken before those arrive photographs a page
  // missing exactly the sections worth looking at.
  await new Promise((resolve) => setTimeout(resolve, 4000))

  /*
   * Does typing on the start page actually reach the search box?
   *
   * `sendInputEvent` is the right tool here and the wrong one elsewhere: it
   * injects into a view's *renderer*, which is below the layer where window
   * hit-testing and drag regions are decided — so it proves nothing about where
   * a real pointer lands, and everything about whether a keystroke reaches a
   * field. Typing is entirely a renderer concern.
   */
  if (process.env['SLASH_TYPEAHEAD_CHECK'] === '1') {
    // Click the page background first, so focus is *not* already in the input.
    // Checking that it works when it was already focused would prove nothing.
    await chrome.executeJavaScript(
      `(() => { const el = document.querySelector('.glass-page'); el && el.focus && el.focus();
                document.body.focus(); return document.activeElement?.tagName ?? ''; })()`
    )

    chrome.focus()
    for (const ch of 'hello') {
      chrome.sendInputEvent({ type: 'keyDown', keyCode: ch })
      chrome.sendInputEvent({ type: 'char', keyCode: ch })
      chrome.sendInputEvent({ type: 'keyUp', keyCode: ch })
    }
    await new Promise((resolve) => setTimeout(resolve, 400))

    const typed = (await chrome.executeJavaScript(
      `(() => {
         const input = document.querySelector('input[aria-label="Search or enter address"]');
         return JSON.stringify({
           value: input ? input.value : null,
           focused: document.activeElement === input
         });
       })()`
    )) as string

    const state = JSON.parse(typed) as { value: string | null; focused: boolean }
    log.info(`type-ahead: value=${JSON.stringify(state.value)} focused=${state.focused}`)
    if (state.value === 'hello' && state.focused) {
      log.info('RESULT: type-ahead PASS — typing reached the search box without a click')
    } else if (state.value === null) {
      log.info('RESULT: type-ahead INCONCLUSIVE — no search box on the page to type into')
    } else {
      log.info('RESULT: type-ahead FAIL — the keystrokes did not land')
    }
  }

  /*
   * Or photograph the overlay instead.
   *
   * The command palette is not in the chrome document — it is a separate
   * `WebContentsView` composited above everything, so `chrome.capturePage()`
   * photographs the page *underneath* it and reports success. Capturing the
   * right view is the whole of the difference between looking at the feature
   * and looking past it.
   *
   * The overlay is transparent, so what comes back is the palette over its own
   * `bg-black/40` scrim with nothing behind it. That is enough to judge the
   * layout, and the honest alternative — compositing two captures — would be a
   * picture the browser never actually drew.
   */
  let shotContents = chrome
  const overlaySurface = process.env['SLASH_CAPTURE_OVERLAY']
  if (overlaySurface === 'command-palette') {
    window.showCommandPalette()
    // Long enough for the overlay document to mount and for its five source
    // fetches to have come back. A capture before those land photographs an
    // empty list, which is indistinguishable from a broken one.
    await new Promise((resolve) => setTimeout(resolve, 1200))

    const overlay = window.overlay.webContents
    if (!overlay || overlay.isDestroyed()) {
      log.warn('overlay has no web contents to capture')
    } else {
      const typed = process.env['SLASH_CAPTURE_QUERY']
      if (typed) {
        overlay.focus()
        for (const ch of typed) {
          overlay.sendInputEvent({ type: 'keyDown', keyCode: ch })
          overlay.sendInputEvent({ type: 'char', keyCode: ch })
          overlay.sendInputEvent({ type: 'keyUp', keyCode: ch })
        }
        // Past the history debounce, which is the slowest source by design.
        await new Promise((resolve) => setTimeout(resolve, 900))
      }

      // Report what it found as well as photographing it, so a run says
      // something even when nobody opens the picture.
      const found = (await overlay.executeJavaScript(
        `(() => {
           const input = document.querySelector('input[aria-label="Command palette"]');
           const groups = [...document.querySelectorAll('section h2')].map((h) => {
             const list = h.parentElement?.querySelector('ul');
             return h.textContent + '=' + (list ? list.children.length : 0);
           });
           return JSON.stringify({ query: input ? input.value : null, groups });
         })()`
      )) as string

      const state = JSON.parse(found) as { query: string | null; groups: string[] }
      if (state.query === null) {
        log.warn('RESULT: palette INCONCLUSIVE — no command palette on the overlay')
      } else {
        log.info(`palette: query=${JSON.stringify(state.query)} ${state.groups.join(' ')}`)
        log.info(
          state.groups.length > 0
            ? `RESULT: palette PASS — ${state.groups.length} source(s) answered`
            : 'RESULT: palette FAIL — nothing matched'
        )
      }
      shotContents = overlay
    }
  } else if (overlaySurface) {
    // Naming a surface nobody wired up should say so rather than quietly
    // capturing the chrome and looking like the surface rendered nothing.
    log.warn(`SLASH_CAPTURE_OVERLAY=${overlaySurface} is not wired up; capturing the chrome`)
  }

  try {
    await fsp.mkdir(dirname(target), { recursive: true })
    const shot = await shotContents.capturePage()
    const png = shot.toPNG()
    if (png.length === 0) {
      log.warn('captured 0 bytes')
      return
    }
    await fsp.writeFile(target, png)
    const { width, height } = shot.getSize()
    log.info(`wrote ${target} — ${width}x${height}, ${Math.round(png.length / 1024)} KB`)
    log.info('RESULT: captured')
  } catch (error) {
    log.warn(`capture failed — ${error instanceof Error ? error.message : String(error)}`)
  }
}
