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

  try {
    await fsp.mkdir(dirname(target), { recursive: true })
    const shot = await chrome.capturePage()
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
