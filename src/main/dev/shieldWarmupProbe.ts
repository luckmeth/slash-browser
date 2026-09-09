import { WebContentsView } from 'electron'
import type { AppContext } from '../AppContext'
import { createLogger } from '../logger'

const log = createLogger('SLASH_SHIELD_WARMUP_PROBE')

/**
 * Why does installing the page-world shield take hundreds of milliseconds?
 *
 * `SLASH_YT_TIMING_PROBE` established the *shape* of the problem — raising the
 * navigation ceiling moved the install with it, so the install lands ~300 ms
 * after the load begins however long you wait — but not the cause. Two
 * explanations fit that curve equally well and they need opposite fixes:
 *
 *  - **No renderer.** A `WebContentsView` that has never navigated has no
 *    renderer process, and `Page.addScriptToEvaluateOnNewDocument` is serviced
 *    *in* the renderer. The command would then sit unanswered until a
 *    navigation spawns one — and the fix is to spawn one early, deliberately,
 *    with a blank document.
 *  - **A busy renderer.** The renderer exists but is saturated parsing the
 *    page, so the reply queues behind it. Then an early blank load buys nothing
 *    and the fix has to be somewhere else entirely.
 *
 * This separates them by measuring three orderings against a real page session.
 * It reports the OS process id at each step, because "is there a renderer" is
 * the entire question and `getOSProcessId()` answers it directly rather than by
 * inference.
 */
const CEILING_MS = 5_000

interface Timing {
  readonly label: string
  readonly pidBefore: number
  readonly pidAfter: number
  readonly prepareMs: number
  readonly installMs: number | null
}

export async function runShieldWarmupProbe(context: AppContext): Promise<void> {
  const rows: Timing[] = []

  const measure = async (
    label: string,
    prepare: (view: WebContentsView) => Promise<void>
  ): Promise<void> => {
    const view = new WebContentsView({
      webPreferences: { session: context.sessions.getDefault(), sandbox: true }
    })
    const contents = view.webContents
    try {
      // What the warm-up costs is the whole question of whether it may be
      // applied to every tab or only to the one destination that needs it —
      // principle 1 does not accept "it is probably small".
      const prepareStarted = Date.now()
      await prepare(view)
      const prepareMs = Date.now() - prepareStarted
      const pidBefore = safePid(contents)

      contents.debugger.attach('1.3')
      const started = Date.now()
      const install = contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: 'void 0',
        runImmediately: true
      })

      // A command that never comes back is the finding, not a hang. Racing it
      // against a ceiling is what lets this report "never" instead of stalling
      // the probe for ever.
      const installMs = await Promise.race([
        install.then(() => Date.now() - started).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CEILING_MS))
      ])

      rows.push({ label, pidBefore, pidAfter: safePid(contents), prepareMs, installMs })
    } catch (error) {
      log.warn(`${label}: threw`, error)
    } finally {
      try {
        if (!contents.isDestroyed()) contents.close()
      } catch {
        // A view that will not close is not a measurement failure.
      }
    }
  }

  // A. Nothing at all. The state every new tab is in when `observe` runs.
  await measure('never navigated', async () => undefined)

  // B. A blank document first, fully loaded. The proposed fix.
  await measure('after about:blank', async (view) => {
    await view.webContents.loadURL('about:blank')
  })

  // C. The blank load started but not awaited, so a renderer is spawning while
  //    the command goes out. Separates "a renderer exists" from "a renderer is
  //    idle" — if this is as fast as B, waiting for the load is unnecessary.
  await measure('during about:blank', async (view) => {
    void view.webContents.loadURL('about:blank')
  })

  log.info('==========================================================')
  for (const row of rows) {
    log.info(
      `${row.label.padEnd(20)} pid ${String(row.pidBefore).padStart(6)} -> ` +
        `${String(row.pidAfter).padStart(6)}   prepare ${String(row.prepareMs).padStart(5)}ms` +
        `   install ${
          row.installMs === null ? `never (> ${CEILING_MS}ms)` : `${row.installMs}ms`
        }   total ${row.installMs === null ? 'n/a' : `${row.prepareMs + row.installMs}ms`}`
    )
  }

  await runNavigationAfterWarmUp(context)

  const cold = rows.find((r) => r.label === 'never navigated')
  const warm = rows.find((r) => r.label === 'after about:blank')
  if (!cold || !warm) {
    log.info('VERDICT: INCONCLUSIVE — a measurement did not complete.')
    return
  }

  if (cold.installMs === null && warm.installMs !== null) {
    log.info('VERDICT: NO RENDERER — the command is never answered by a target')
    log.info('  that has never navigated, and is answered in')
    log.info(`  ${warm.installMs}ms once a blank document exists. Loading about:blank`)
    log.info('  before the real URL is therefore the fix: it buys a live, idle')
    log.info('  renderer to install into.')
  } else if (cold.installMs !== null && cold.installMs < 50) {
    log.info('VERDICT: RENDERER NOT THE CAUSE — the install is fast against a')
    log.info('  target that has never navigated, so the delay measured during a')
    log.info('  real navigation comes from renderer contention, not from the')
    log.info('  absence of one. An early blank load would buy nothing.')
  } else {
    log.info('VERDICT: MIXED — read the rows above; neither explanation fits')
    log.info('  cleanly and the fix should not be guessed from this.')
  }
}

function safePid(contents: Electron.WebContents): number {
  try {
    return contents.isDestroyed() ? -1 : contents.getOSProcessId()
  } catch {
    return -1
  }
}


/**
 * Does a real navigation still happen after the warm-up?
 *
 * It did not, and that is the entire reason this section exists. With the blank
 * load awaited and the shield installed, `loadURL` was called with the right
 * address, did not reject, and the tab sat on `about:blank` for twenty seconds.
 * A first navigation that silently never happens is a far worse bug than the
 * advert being fixed, so the ordering is measured here in isolation — no tabs,
 * no shield, no settings — to find out which part of it is at fault.
 */
async function runNavigationAfterWarmUp(context: AppContext): Promise<void> {
  const target = 'https://example.com/'

  const attempt = async (
    label: string,
    between: () => Promise<void>
  ): Promise<void> => {
    const view = new WebContentsView({
      webPreferences: { session: context.sessions.getDefault(), sandbox: true }
    })
    const contents = view.webContents
    try {
      await contents.loadURL('about:blank')
      await between()
      const started = Date.now()
      let rejected: string | null = null
      await contents.loadURL(target).catch((error: unknown) => {
        rejected = String(error)
      })
      log.info(
        `${label.padEnd(26)} url=${contents.getURL().slice(0, 40).padEnd(30)} ` +
          `${Date.now() - started}ms${rejected === null ? '' : `  rejected: ${rejected}`}`
      )
    } catch (error) {
      log.info(`${label.padEnd(26)} threw: ${String(error)}`)
    } finally {
      try {
        if (!contents.isDestroyed()) contents.close()
      } catch {
        // Closing a probe view is not part of the measurement.
      }
    }
  }

  await runWarmUpCost(context)

  await runHistoryAfterWarmUp(context)

  log.info('--- navigating after a warm-up blank load ---')
  // Straight out of the `loadURL` continuation, which is what the fix does.
  await attempt('immediately', async () => undefined)
  // One macrotask later. If this is the one that works, the navigation
  // controller is simply not ready to be re-entered from its own callback.
  await attempt('after a macrotask', () => new Promise((r) => setTimeout(r, 0)))
  // A visible pause, to separate "needs a tick" from "needs real time".
  await attempt('after 100ms', () => new Promise((r) => setTimeout(r, 100)))
}


/**
 * What the warm-up does to the back history.
 *
 * A blank page we asked for explicitly is a history entry like any other, and a
 * Back button that returns to a blank page is a worse bug than the advert. The
 * first attempt to clean it up produced **two identical entries** and a tab
 * reporting `canGoBack=false` while holding a forward entry, which is a
 * different kind of wrong. So both orderings are measured here, on a real
 * navigation, rather than reasoned about.
 */
async function runHistoryAfterWarmUp(context: AppContext): Promise<void> {
  const target = 'https://example.com/'

  const attempt = async (label: string, removeBlank: boolean): Promise<void> => {
    const view = new WebContentsView({
      webPreferences: { session: context.sessions.getDefault(), sandbox: true }
    })
    const contents = view.webContents
    try {
      await contents.loadURL('about:blank')
      const afterBlank = describeHistory(contents)

      if (removeBlank) {
        contents.once('did-navigate', () => {
          try {
            const entries = contents.navigationHistory.getAllEntries()
            if (entries.length >= 2 && entries[0]?.url === 'about:blank') {
              contents.navigationHistory.removeEntryAtIndex(0)
            }
          } catch {
            // Reported by the row below rather than thrown.
          }
        })
      }

      await contents.loadURL(target).catch(() => undefined)
      // A moment for any in-page navigation the site does on load.
      await new Promise((resolve) => setTimeout(resolve, 500))
      log.info(`${label.padEnd(26)} blank:[${afterBlank}]  final:[${describeHistory(contents)}]`)
    } catch (error) {
      log.info(`${label.padEnd(26)} threw: ${String(error)}`)
    } finally {
      try {
        if (!contents.isDestroyed()) contents.close()
      } catch {
        // Closing a probe view is not part of the measurement.
      }
    }
  }

  log.info('--- the warm-up blank page in the back history ---')
  await attempt('left alone', false)
  await attempt('removed on did-navigate', true)
}

function describeHistory(contents: Electron.WebContents): string {
  try {
    const entries = contents.navigationHistory.getAllEntries()
    const index = contents.navigationHistory.getActiveIndex()
    const urls = entries.map((entry) => entry.url.replace('https://', '')).join(' | ')
    return `n=${entries.length} i=${index} back=${contents.navigationHistory.canGoBack()} ${urls}`
  } catch (error) {
    return `unreadable (${String(error)})`
  }
}


/**
 * What does the warm-up cost a page that did not need it?
 *
 * The warm-up is currently applied only where the shield is time-critical, which
 * means the pop-up defuser and the right-click restorer still install *after* the
 * first navigation of every other tab has begun. Widening it is obviously
 * tempting and is exactly the kind of change principle 1 exists to stop being
 * made on a hunch — so this measures the thing that would change: **total time
 * from a fresh view to a loaded page**, with and without a blank document first.
 *
 * Both arms are timed the same way, several times, because a single navigation
 * over a real network varies by more than the effect being looked for.
 */
async function runWarmUpCost(context: AppContext): Promise<void> {
  const target = 'https://example.com/'
  const runs = 5

  const time = async (warmUp: boolean): Promise<number> => {
    const view = new WebContentsView({
      webPreferences: { session: context.sessions.getDefault(), sandbox: true }
    })
    const contents = view.webContents
    const started = Date.now()
    try {
      if (warmUp) await contents.loadURL('about:blank').catch(() => undefined)
      await contents.loadURL(target).catch(() => undefined)
      return Date.now() - started
    } finally {
      try {
        if (!contents.isDestroyed()) contents.close()
      } catch {
        // Not part of the measurement.
      }
    }
  }

  const direct: number[] = []
  const warmed: number[] = []
  for (let run = 0; run < runs; run += 1) {
    // Interleaved rather than run in two blocks, so a network that gets slower
    // partway through penalises both arms equally instead of only the second.
    direct.push(await time(false))
    warmed.push(await time(true))
  }

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] ?? 0
  }

  const directMedian = median(direct)
  const warmedMedian = median(warmed)

  log.info('--- what a warm-up costs a page that did not need it ---')
  log.info(`  straight to the page   ${direct.join('ms, ')}ms   median ${directMedian}ms`)
  log.info(`  blank document first   ${warmed.join('ms, ')}ms   median ${warmedMedian}ms`)
  log.info(`  difference: ${warmedMedian - directMedian}ms on the median`)
  if (warmedMedian - directMedian > 40) {
    log.info('  READING: too expensive to apply to every tab. Principle 1 says the')
    log.info('    warm-up stays scoped to destinations that need it.')
  } else {
    log.info('  READING: cheap enough to consider applying to every first')
    log.info('    navigation, which would put the pop-up defuser and the')
    log.info('    right-click restorer in place before the page runs.')
  }
}
