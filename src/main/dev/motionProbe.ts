import { app } from 'electron'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Is the motion work actually reaching the screen on this machine?
 *
 * "I installed it and saw none of it" has three quite different causes and they
 * need three different answers: the build does not contain it, the system has
 * asked for reduced motion and every animation is being skipped **by design**,
 * or it is running and simply too subtle. Guessing between those wastes a
 * release; this measures.
 *
 * The reduced-motion case is the one worth naming. On Windows, Settings →
 * Accessibility → Visual effects → "Animation effects" being off makes Chromium
 * report `prefers-reduced-motion: reduce`, and everything here is deliberately
 * gated behind `no-preference`. That is correct behaviour and also completely
 * invisible, so it looks identical to nothing having been built.
 */
export async function runMotionProbe(window: BrowserWindowController): Promise<void> {
  const chrome = window.privilegedContents()[0]
  if (!chrome) {
    log.error('motion probe: FAIL — no chrome view')
    app.quit()
    return
  }

  // Frames through the launch sequence, so it can be judged rather than
  // described. A 900ms animation is either visible in these or it is not.
  const frameDir = process.env['SLASH_MOTION_FRAMES']
  if (frameDir) {
    const path = await import('node:path')
    const fsp = (await import('node:fs')).promises
    await fsp.mkdir(frameDir, { recursive: true })
    // `capturePage()` on the chrome view, not the desktop capturer used
    // elsewhere: the desktop path takes hundreds of milliseconds to set up, so
    // the very first frame already showed a settled browser and the sequence
    // looked like it had never run.
    const started = Date.now()
    for (let frame = 0; frame < 12; frame += 1) {
      try {
        const shot = await chrome.capturePage()
        const png = shot.toPNG()
        const at = String(Date.now() - started).padStart(4, '0')
        if (png.length === 0) {
          log.warn(`motion probe: frame at ${at}ms captured 0 bytes`)
        } else {
          await fsp.writeFile(path.join(frameDir, `boot-${at}ms.png`), png)
        }
      } catch (error) {
        log.warn(`motion probe: capture failed — ${error instanceof Error ? error.message : String(error)}`)
      }
      await delay(110)
    }
    log.info(`motion probe: wrote boot frames to ${frameDir}`)
  }

  // Early enough to catch the launch sequence, which clears at ~900ms.
  const early = (await chrome
    .executeJavaScript(
      `JSON.stringify({
         reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
         bootLayer: !!document.querySelector('.slash-boot'),
         markDrawing: !!document.querySelector('.slash-mark-draw')
       })`
    )
    .catch(() => '{}')) as string
  log.info(`motion probe: at startup -> ${early}`)

  await delay(2500)

  const settled = (await chrome
    .executeJavaScript(
      `(() => {
         const styleFor = (sel) => {
           const el = document.querySelector(sel);
           if (!el) return null;
           const cs = getComputedStyle(el);
           return { animation: cs.animationName, duration: cs.animationDuration, transition: cs.transitionProperty.slice(0, 60) };
         };
         return JSON.stringify({
           reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
           bootLayerGone: !document.querySelector('.slash-boot'),
           // The classes are on the elements whether or not the CSS applies —
           // what matters is the computed style the media query decides.
           tabHasGlowClass: !!document.querySelector('.slash-glow'),
           activeTabLit: !!document.querySelector('.slash-glow-on'),
           tabStyle: styleFor('.slash-tab-in'),
           rowsStaggered: !!document.querySelector('.slash-row-1')
         });
       })()`
    )
    .catch(() => '{}')) as string
  log.info(`motion probe: settled -> ${settled}`)

  const parsed = JSON.parse(settled || '{}') as { reducedMotion?: boolean }
  if (parsed.reducedMotion === true) {
    log.warn(
      'motion probe: this machine asks for REDUCED MOTION — every animation is being skipped on ' +
        'purpose. Windows: Settings → Accessibility → Visual effects → Animation effects.'
    )
  }

  if (process.env['SLASH_PROBE_EXIT']) app.quit()
}
