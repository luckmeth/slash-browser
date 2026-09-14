import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import { NEW_TAB_URL, isInternalUrl } from '@shared/types/tab'
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
    const background = process.env['SLASH_CAPTURE_BACKGROUND'] === '1'
    window.tabs.create({ url: targetUrl, background })

    /*
     * Then come back to the start page.
     *
     * `background: true` is not enough on a fresh profile: the created tab is
     * the window's first, so it activates whatever was asked for. Some of what
     * is worth photographing on the start page — Resume your work — only
     * appears once there are real tabs to resume, so the probe has to both open
     * one and then look away from it.
     */
    /*
     * Optionally more than once, so duplicate detection has something to find.
     * Two tabs at the same address is exactly the state Tab Health and the
     * palette's close-duplicates command exist for, and a probe that cannot
     * reach it cannot check either of them.
     */
    const copies = Number(process.env['SLASH_CAPTURE_COPIES'] ?? '0')
    for (let i = 0; i < copies; i += 1) {
      window.tabs.create({ url: targetUrl, background: true })
    }

    // A second, different page — for anything that needs two real documents to
    // look at rather than two copies of one. Compare Tabs is the reason.
    const second = process.env['SLASH_CAPTURE_URL_2']
    if (second) window.tabs.create({ url: second, background: true })

    if (background) {
      const internal = window.tabs.allTabs().find((tab) => isInternalUrl(tab.snapshot.url))
      if (internal) window.tabs.activate(internal.id)
      else window.tabs.create({ url: NEW_TAB_URL, background: false })
    }
  }

  /*
   * Long enough for `animate-rise`, the sponsored batch and the rewards status
   * to have landed. A capture taken before those arrive photographs a page
   * missing exactly the sections worth looking at.
   *
   * `SLASH_CAPTURE_SETTLE` extends it for anything that needs a page to have
   * finished doing something — the protection report counts requests the shield
   * cancelled, and a report read while the page is still loading correctly says
   * nothing happened.
   */
  const settleMs = Number(process.env['SLASH_CAPTURE_SETTLE'] ?? '4000')
  await new Promise((resolve) => setTimeout(resolve, settleMs))

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
   * Optionally close the tab first.
   *
   * The only way to put something in the recently-closed list is to close
   * something, and a probe that cannot reach that state cannot check the rows
   * that depend on it.
   */
  if (process.env['SLASH_CAPTURE_CLOSE_TAB'] === '1') {
    const active = window.tabs.snapshot().activeTabId
    if (active) {
      window.tabs.close(active)
      log.info(`closed the active tab (${active}) to fill the recently-closed list`)
      await new Promise((resolve) => setTimeout(resolve, 400))
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
  /*
   * Optionally open a side panel.
   *
   * Panels are React in the *chrome* document — they inset the page rather than
   * floating over it — so the ordinary chrome capture photographs them. Routed
   * through `ui:run` because that is the path a menu accelerator takes, which
   * means the probe exercises the real command rather than a shortcut into the
   * store that no user has.
   */
  const panel = process.env['SLASH_CAPTURE_PANEL']
  if (panel) {
    chrome.send('ui:command', { command: panel })
    // Long enough for the panel's own fetches — a performance snapshot is
    // sampled rather than held, so capturing early photographs "Measuring…".
    await new Promise((resolve) => setTimeout(resolve, 2500))
  }

  /*
   * Drive the chrome document before photographing it.
   *
   * Some panels only show their real output after somebody has chosen
   * something — Compare pages is empty until two tabs are ticked and the button
   * pressed. `SLASH_CAPTURE_CLICK` is an expression evaluated in the chrome
   * document, so the probe exercises the actual UI path rather than calling the
   * service behind it and photographing a screen nobody could have produced.
   */
  /*
   * The same, but in the overlay document.
   *
   * Surfaces that float over the page — the download chip, the palette, the
   * permission prompt — live in a different document from the chrome, so a
   * script aimed at them has to be evaluated there.
   */
  const overlayScript = process.env['SLASH_CAPTURE_OVERLAY_CLICK']
  if (overlayScript) {
    const overlay = window.overlay.webContents
    if (!overlay || overlay.isDestroyed()) {
      log.warn('no overlay to run the script in')
    } else {
      try {
        const started: unknown = await overlay.executeJavaScript(overlayScript)
        log.info(`overlay script returned ${JSON.stringify(started)}`)
      } catch (error) {
        log.warn(`overlay script failed — ${String(error)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 2500))
      try {
        const result = await overlay.executeJavaScript(
          'JSON.stringify(window.__slashProbeResult ?? null)'
        )
        if (typeof result === 'string' && result !== 'null') {
          log.info(`RESULT: overlay script — ${result}`)
        }
      } catch (error) {
        log.warn(`could not read the overlay script's result — ${String(error)}`)
      }
    }
  }

  const clickScript = process.env['SLASH_CAPTURE_CLICK']
  if (clickScript) {
    try {
      const clicked: unknown = await chrome.executeJavaScript(clickScript)
      log.info(`click script returned ${JSON.stringify(clicked)}`)
    } catch (error) {
      log.warn(`click script failed — ${String(error)}`)
    }
    // Long enough for whatever it started to have come back.
    await new Promise((resolve) => setTimeout(resolve, Number(process.env['SLASH_CAPTURE_CLICK_WAIT'] ?? '3000')))

    /*
     * A script that reports asynchronously leaves its answer on a global.
     *
     * Not `document.title`: the chrome document's title is synced from the tab
     * snapshot, so the app overwrites anything written there within a frame —
     * which is exactly what happened on the first attempt, and reported nothing
     * rather than reporting wrongly.
     */
    try {
      const asyncResult = await chrome.executeJavaScript(
        // Storage first: a renderer that reloaded has lost its globals, and a
        // probe that reports nothing is indistinguishable from one whose script
        // never ran.
        `JSON.stringify(window.__slashProbeResult ?? JSON.parse(localStorage.getItem('slashProbeLog') || 'null'))`
      )
      if (typeof asyncResult === 'string' && asyncResult !== 'null') {
        log.info(`RESULT: click script — ${asyncResult}`)
      }
    } catch (error) {
      // Said out loud rather than swallowed: a probe that reports nothing when
      // its own read failed is indistinguishable from one whose script never
      // ran, and that cost several rounds here.
      log.warn(`could not read the click script's result — ${String(error)}`)
    }
  }

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
      /*
       * And optionally accept the top row.
       *
       * The rows run IPC this probe cannot reach any other way, and a row whose
       * handler is wrong does not fail — it does nothing, which is
       * indistinguishable from a control that is broken. Pressing Enter and then
       * reading the tab list is the only check that tells those apart.
       */
      if (process.env['SLASH_CAPTURE_ENTER'] === '1') {
        const before = window.tabs.allTabs().length
        overlay.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
        overlay.sendInputEvent({ type: 'char', keyCode: 'Return' })
        overlay.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
        await new Promise((resolve) => setTimeout(resolve, 1500))

        const after = window.tabs.allTabs()
        const urls = after.map((tab) => tab.snapshot.url).join(' ')
        log.info(`enter: tabs ${before} -> ${after.length} [${urls}]`)
        log.info(
          after.length > before
            ? 'RESULT: palette-enter PASS — the row opened a tab'
            : 'RESULT: palette-enter FAIL — the row did nothing'
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
