import { app, BrowserWindow, screen } from 'electron'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Does the toolbar come back when a **real** pointer reaches the top?
 *
 * The word real is the whole point of this probe, and it was learned the hard
 * way. The first version drove `webContents.sendInputEvent`, which injects an
 * event directly into a view's renderer — and it passed against the broken
 * code. It could not do otherwise: `sendInputEvent` starts *below* the layer
 * where the failure happens.
 *
 * A physical mouse is hit-tested by Windows first. This window is
 * `titleBarStyle: 'hidden'`, which keeps the native frame, so the outermost few
 * pixels of every edge are the OS resize border — `SM_CYSIZEFRAME +
 * SM_CXPADDEDBORDER`, typically eight. The pointer there belongs to the window
 * manager, which shows a resize cursor; Chromium is never asked, no view
 * receives anything, and a hover strip thinner than that border can never fire.
 * That is why auto-hide hid the chrome and had no way to bring it back, and
 * why every in-process test agreed the code was fine.
 *
 * So this one moves the actual system cursor and watches what happens, which is
 * the only vantage point from which the bug is visible at all. The cursor is
 * driven from outside the process — see `docs/testing/download-manager.md` —
 * and this side reports the window's screen rectangle to aim at, then waits.
 */
export async function runAutoHideProbe(window: BrowserWindowController): Promise<void> {
  let failures = 0
  const check = (name: string, passed: boolean, detail: string): void => {
    if (!passed) failures += 1
    log[passed ? 'info' : 'error'](`auto-hide probe [${name}]: ${passed ? 'PASS' : 'FAIL'} — ${detail}`)
  }

  const chrome = window.privilegedContents()[0]
  const host = chrome ? BrowserWindow.fromWebContents(chrome) : null
  if (!chrome || !host) {
    log.error('auto-hide probe: FAIL — no chrome view')
    if (process.env['SLASH_PROBE_EXIT']) app.quit()
    return
  }

  const collapsed = '.pointer-events-none.max-h-0'
  const isCollapsed = (): Promise<boolean> =>
    chrome.executeJavaScript(`!!document.querySelector('${collapsed}')`) as Promise<boolean>

  try {
    host.setAlwaysOnTop(true)
    host.focus()

    // Maximised, because that is how a browser is normally used and because a
    // restored window hid the bug: on Windows a maximised window's `getBounds`
    // extends *past* the screen by the invisible resize border, so its `y` is
    // negative and a reveal band measured from it sits above y=0 where no
    // cursor can ever go.
    if (process.env['SLASH_AUTOHIDE_RESTORED'] !== '1') {
      host.maximize()
      await delay(600)
    }

    const work = screen.getDisplayMatching(host.getBounds()).workArea
    log.info(
      `auto-hide probe: maximized=${host.isMaximized()} ` +
        `bounds=${JSON.stringify(host.getBounds())} ` +
        `content=${JSON.stringify(host.getContentBounds())} ` +
        `workArea=${JSON.stringify(work)}`
    )

    // What the driver outside this process needs in order to aim.
    const bounds = host.getContentBounds()
    const scale = screen.getDisplayMatching(bounds).scaleFactor
    log.info(`auto-hide probe: window ${JSON.stringify(bounds)} scale=${scale}`)
    log.info(`auto-hide probe: PARK ${Math.round(bounds.x + bounds.width / 2)} ${Math.round(bounds.y + bounds.height / 2)}`)
    log.info(`auto-hide probe: AIM ${Math.round(bounds.x + bounds.width / 2)} ${bounds.y + 1}`)

    // The cursor has to start away from the top edge, or auto-hide reveals the
    // chrome the instant it engages and there is nothing left to test. A
    // previous run of this probe leaves the pointer exactly where it must not
    // be, which is how that was discovered.
    const parked = Date.now() + 60_000
    while (Date.now() < parked) {
      const point = screen.getCursorScreenPoint()
      if (point.y > bounds.y + 80) break
      await delay(200)
    }
    const startPoint = screen.getCursorScreenPoint()
    check(
      'cursor-parked',
      startPoint.y > bounds.y + 80,
      startPoint.y > bounds.y + 80
        ? `the pointer starts at y=${startPoint.y}, clear of the top edge at ${bounds.y}`
        : `the pointer is still at y=${startPoint.y}, inside the reveal band — the run below would prove nothing`
    )

    // Awaited, and read back. A fixed sleep after a fire-and-forget invoke was
    // not enough: the update round-trips through main, the store and a
    // broadcast, and when it lost that race the probe reported "auto-hide did
    // not collapse" for a build in which it worked perfectly.
    // Does the broadcast reach this document at all?
    await chrome.executeJavaScript(
      `(() => { window.__slashSettingsEvents = 0;
                window.browser.on('settings:changed', () => { window.__slashSettingsEvents++ });
                return true })()`
    )

    const applied = (await chrome.executeJavaScript(
      `window.browser
         .invoke('settings:update', { autoHideChrome: true })
         .then(() => window.browser.invoke('settings:getAll', undefined))
         .then((r) => (r.ok ? r.value.autoHideChrome : 'update failed'))`
    )) as boolean | string
    log.info(`auto-hide probe: setting reads back as ${String(applied)}`)
    await delay(1200)
    const events = (await chrome.executeJavaScript('window.__slashSettingsEvents')) as number
    log.info(`auto-hide probe: settings:changed events seen by the chrome document = ${events}`)

    // Then poll for the collapse rather than assuming a duration.
    for (let waited = 0; waited < 8000 && !(await isCollapsed()); waited += 200) {
      await delay(200)
    }

    // What the rows actually look like, so a failure here names the reason
    // instead of only reporting that a selector missed.
    const shape = (await chrome.executeJavaScript(`
      (() => {
        const rows = document.querySelectorAll('div');
        for (const el of rows) {
          if (el.className && String(el.className).includes('max-h-')) {
            const r = el.getBoundingClientRect();
            return { cls: String(el.className).slice(0, 200), h: r.height };
          }
        }
        return { cls: 'no element with a max-h- class', h: -1 };
      })()
    `)) as { cls: string; h: number }
    log.debug(`auto-hide probe: rows -> ${shape.h}px  class="${shape.cls}"`)

    const collapsedNow = await isCollapsed()
    check(
      'chrome-hides',
      collapsedNow,
      collapsedNow
        ? 'the rows collapsed with the setting on, so a reveal below means something'
        : 'auto-hide did not collapse the rows, so the reveal below would prove nothing'
    )

    // Wait for the cursor to arrive and the chrome to come back. Polling here
    // rather than a fixed sleep, so a slow machine reports the truth instead of
    // a timing artefact.
    const deadline = Date.now() + 60_000
    let revealed = false
    let sawCursorAtTop = false
    while (Date.now() < deadline) {
      const point = screen.getCursorScreenPoint()
      if (point.y <= bounds.y + 8 && Math.abs(point.x - (bounds.x + bounds.width / 2)) < 200) {
        sawCursorAtTop = true
      }
      if (!(await isCollapsed())) {
        revealed = true
        break
      }
      await delay(200)
    }

    check(
      'cursor-reached-the-top',
      sawCursorAtTop,
      sawCursorAtTop
        ? 'the system cursor was observed inside the top edge of the window'
        : 'the cursor never arrived — the driver did not run, so the result below proves nothing'
    )
    check(
      'chrome-returns',
      revealed,
      revealed
        ? 'the rows expanded again once the real pointer reached the top edge'
        : 'the chrome stayed hidden with the pointer on the top edge'
    )

    // ---- and it must go away again -----------------------------------------
    // Hiding used to be a DOM `mouseleave`, which fired the instant the pointer
    // crossed into the page — the bars vanished on the way to a tab, which is
    // what "not working intelligently" meant. Main drives both directions now,
    // and the thresholds differ: revealing needs the top few pixels, hiding
    // needs the pointer well clear of the chrome's bottom.
    log.info(`auto-hide probe: PARK ${Math.round(bounds.x + bounds.width / 2)} ${Math.round(bounds.y + bounds.height / 2)}`)

    const hideBy = Date.now() + 40_000
    let hidAgain = false
    let restedNearChrome = false
    while (Date.now() < hideBy) {
      const point = screen.getCursorScreenPoint()
      // Just under the bars: close enough that a single threshold would flip,
      // far enough that the pointer has genuinely left them.
      if (point.y > bounds.y + 40 && point.y < bounds.y + 130) restedNearChrome = true
      if (await isCollapsed()) {
        hidAgain = true
        break
      }
      await delay(200)
    }
    check(
      'chrome-hides-again',
      hidAgain,
      hidAgain
        ? 'the rows collapsed once the pointer moved well clear of them'
        : 'the chrome stayed open with the pointer down in the page'
    )
    check(
      'no-hair-trigger',
      restedNearChrome,
      restedNearChrome
        ? 'the pointer passed through the band just below the bars without them snapping shut early'
        : 'the pointer never rested near the chrome, so hysteresis was not exercised'
    )

    await chrome.executeJavaScript(
      `window.browser.invoke('settings:update', { autoHideChrome: false })`
    )
    await delay(400)
  } catch (error) {
    check('ran', false, error instanceof Error ? error.message : String(error))
  } finally {
    host.setAlwaysOnTop(false)
  }

  log.info(`auto-hide probe: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
  if (process.env['SLASH_PROBE_EXIT']) app.quit()
}
