import { app } from 'electron'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface SessionProbeHooks {
  /** What startup would restore, asked exactly as `main/index.ts` asks it. */
  restorable: () => { tabs: unknown[]; kind: string; createdAt: number } | null
}

/**
 * Two failures reported together, because they turned out to be one story.
 *
 * A user could not close some tabs, gave up, ended the browser from outside,
 * and lost everything they had open. The second half is not bad luck: a
 * `session-end` snapshot is only written on an orderly quit, so a force-kill
 * relies entirely on the automatic one — which ran every five minutes. Open
 * twenty tabs, hit the first problem four minutes in, kill it, and there is no
 * record of any of them.
 *
 * The first half is why they killed it. The strip predicted its own overflow
 * from tab widths without subtracting its own padding, and the branch it took
 * when it believed everything fitted was `overflow-hidden` — so the tabs past
 * the edge were clipped with no way to scroll to them. Not narrow: unreachable.
 *
 * So this opens enough tabs to overflow a real strip and checks the layout's
 * own numbers, then waits for the debounced autosave and asks what a restart
 * would bring back.
 */
export async function runSessionProbe(
  window: BrowserWindowController,
  hooks: SessionProbeHooks
): Promise<void> {
  let failures = 0
  const check = (name: string, passed: boolean, detail: string): void => {
    if (!passed) failures += 1
    log[passed ? 'info' : 'error'](`session probe [${name}]: ${passed ? 'PASS' : 'FAIL'} — ${detail}`)
  }

  const chrome = window.privilegedContents()[0]
  if (!chrome) {
    log.error('session probe: FAIL — no chrome view')
    app.quit()
    return
  }

  try {
    // Enough to overflow any reasonable strip.
    const wanted = 25
    for (let at = 0; at < wanted; at += 1) {
      window.tabs.create({ url: `https://example.com/tab-${at}`, background: true })
    }
    await delay(3000)

    const open = window.tabs.allTabs().length
    check('tabs-opened', open >= wanted, `${open} tabs open`)

    // ---- 1. can every tab still be reached? ------------------------------
    const strip = (await chrome.executeJavaScript(`
      (() => {
        const el = document.querySelector('[role="tablist"]');
        if (!el) return { found: false };
        const style = getComputedStyle(el);
        const tabs = [...el.querySelectorAll('[role="tab"]')];
        const lefts = tabs.map((t) => t.offsetLeft);
        return {
          found: true,
          overflowX: style.overflowX,
          justify: style.justifyContent,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          tabs: tabs.length,
          minLeft: lefts.length ? Math.min(...lefts) : 0,
          maxRight: tabs.length
            ? Math.max(...tabs.map((t) => t.offsetLeft + t.offsetWidth))
            : 0
        };
      })()
    `)) as {
      found: boolean
      overflowX: string
      justify: string
      scrollWidth: number
      clientWidth: number
      tabs: number
      minLeft: number
      maxRight: number
    }

    check('strip-rendered', strip.found && strip.tabs > 0, `${strip.tabs} tab elements`)

    const overflows = strip.scrollWidth > strip.clientWidth + 1
    log.info(
      `session probe: strip scrollWidth=${strip.scrollWidth} clientWidth=${strip.clientWidth} ` +
        `overflowX=${strip.overflowX} justify=${strip.justify}`
    )

    // The bug, stated as the property that was violated: content wider than the
    // box, and no way to scroll to the rest of it.
    check(
      'overflow-is-reachable',
      !overflows || strip.overflowX === 'auto' || strip.overflowX === 'scroll',
      overflows
        ? `content is ${strip.scrollWidth - strip.clientWidth}px wider than the strip and overflow-x is "${strip.overflowX}"`
        : 'everything fits, so nothing can be clipped'
    )
    check(
      'no-tab-before-the-start',
      strip.minLeft >= 0,
      // `justify-center` on a scrolling row pushes the first tabs to a negative
      // offset that no amount of scrolling reaches.
      `leftmost tab starts at ${strip.minLeft}px`
    )
    check(
      'centred-only-when-it-fits',
      !overflows || strip.justify !== 'center',
      `justify-content is "${strip.justify}" while ${overflows ? 'overflowing' : 'fitting'}`
    )

    // ---- 1b. the same invariant at every width, on the way down ----------
    // 53 tabs is far past the boundary and the old bug lived *at* it: the strip
    // mispredicted by exactly the 16px of its own padding, so it only clipped
    // when the run was within a hair of fitting. Closing tabs walks through
    // that point, and doing it by closing also checks the thing the user
    // actually could not do.
    const readStrip = (): Promise<{ scroll: number; client: number; overflowX: string; minLeft: number }> =>
      chrome.executeJavaScript(`
        (() => {
          const el = document.querySelector('[role="tablist"]');
          const tabs = [...el.querySelectorAll('[role="tab"]')];
          const lefts = tabs.map((t) => t.offsetLeft);
          return {
            scroll: el.scrollWidth,
            client: el.clientWidth,
            overflowX: getComputedStyle(el).overflowX,
            minLeft: lefts.length ? Math.min(...lefts) : 0
          };
        })()
      `) as Promise<{ scroll: number; client: number; overflowX: string; minLeft: number }>

    let clipped = 0
    let negative = 0
    let closesThatDidNothing = 0
    const widths: string[] = []

    for (let step = 0; step < 12; step += 1) {
      const before = window.tabs.allTabs().length
      if (before <= 2) break
      // Close from the end, four at a time, so the run narrows through the
      // boundary rather than jumping past it.
      for (const tab of window.tabs.allTabs().slice(-4)) window.tabs.close(tab.id)
      await delay(350)

      const after = window.tabs.allTabs().length
      if (after >= before) closesThatDidNothing += 1

      const strip = await readStrip()
      const overflows = strip.scroll > strip.client + 1
      if (overflows && strip.overflowX !== 'auto' && strip.overflowX !== 'scroll') clipped += 1
      if (strip.minLeft < 0) negative += 1
      widths.push(`${after}:${strip.scroll}/${strip.client}`)
    }

    log.info(`session probe: sweep ${widths.join(' ')}`)
    check(
      'closing-actually-closes',
      closesThatDidNothing === 0,
      closesThatDidNothing === 0
        ? 'every close reduced the tab count'
        : `${closesThatDidNothing} round(s) closed nothing`
    )
    check(
      'never-clipped-at-any-width',
      clipped === 0,
      clipped === 0
        ? 'the strip stayed scrollable through the boundary'
        : `clipped at ${clipped} width(s) — tabs were unreachable`
    )
    check(
      'never-scrolled-off-the-left',
      negative === 0,
      negative === 0 ? 'the run always started at or after 0' : `${negative} width(s) had a negative offset`
    )

    // ---- 2. would a force-kill lose them? --------------------------------
    // Nothing is quit here. The question is only whether a record exists that
    // startup would read, which is exactly what a kill leaves behind.
    log.info('session probe: waiting for the debounced autosave…')
    await delay(9000)

    const restorable = hooks.restorable()
    check(
      'session-recorded-without-quitting',
      restorable !== null && restorable.tabs.length > 0,
      restorable === null
        ? 'nothing would be restored — a force-kill right now loses every tab'
        : `${restorable.tabs.length} tab(s) in the latest ${restorable.kind} snapshot`
    )
    if (restorable) {
      // Against what is open *now*, after the sweep closed most of them — a
      // snapshot still listing the closed ones would reopen tabs the user shut.
      const openNow = window.tabs.allTabs().length
      check(
        'matches-what-is-open',
        Math.abs(restorable.tabs.length - openNow) <= 2,
        `${restorable.tabs.length} recorded against ${openNow} open`
      )
      const age = Date.now() - restorable.createdAt
      check(
        'recorded-recently',
        age < 60_000,
        // Five minutes was the old floor, and it is the gap that lost the work.
        `the snapshot is ${Math.round(age / 1000)}s old`
      )
    }
  } catch (error) {
    check('ran', false, error instanceof Error ? error.message : String(error))
  }

  log.info(`session probe: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
  if (process.env['SLASH_PROBE_EXIT']) app.quit()
}
