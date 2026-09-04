import { app } from 'electron'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const TARGET =
  process.env['SLASH_YT_URL'] ?? 'https://www.youtube.com/watch?v=vrzIePSBu8k&t=2685s'

export interface QualityProbeHooks {
  qualities: (window: BrowserWindowController) => Promise<{
    available: boolean
    levels: { level: string; label: string; current: boolean }[]
    note: string | null
  }>
  request: (
    window: BrowserWindowController,
    level: string
  ) => Promise<{ ok: boolean; now: string; found: number; note: string }>
  options: (window: BrowserWindowController) => Promise<{
    choices: { url: string; label: string }[]
    note: string | null
  }>
}

/**
 * Does asking the player for a quality actually make that quality downloadable?
 *
 * The whole feature rests on a chain nothing else tests end to end: read the
 * levels out of the site's own player, ask it to switch using its own public
 * API, wait for it to fetch, and see whether the sniffer now holds something.
 * Any link can be sound while the chain is useless — the player switched to
 * 1080p in an earlier measurement and the sniffer still held nothing, which
 * would make the picker offer a button that changes what you are watching and
 * gives you no download for it.
 *
 * So this runs the **real** `playerQualitiesFor` and `requestPlayerQuality`,
 * not a reimplementation, and reports what came back.
 */
export async function runQualityProbe(
  window: BrowserWindowController,
  hooks: QualityProbeHooks
): Promise<void> {
  const activeId = window.tabs.snapshot().activeTabId
  if (!activeId) {
    log.error('quality probe: FAIL — no active tab')
    app.quit()
    return
  }

  window.tabs.navigate(activeId, TARGET)
  log.info(`quality probe: loading ${TARGET}`)
  await delay(14_000)

  const contents = window.tabs.activeTab?.contents ?? null
  if (contents) {
    // Autoplay is blocked under automation; without this nothing streams and
    // every reading below is a measurement of a paused player.
    await contents
      .executeJavaScript(
        `(() => { const v = document.querySelector('video'); if (!v) return false; v.muted = true; v.play(); return true })()`,
        true
      )
      .catch(() => false)
    await delay(10_000)
  }

  let failures = 0
  const check = (name: string, passed: boolean, detail: string): void => {
    if (!passed) failures += 1
    log[passed ? 'info' : 'error'](`quality probe [${name}]: ${passed ? 'PASS' : 'FAIL'} — ${detail}`)
  }

  try {
    const before = await hooks.options(window)
    log.info(
      `quality probe: before switching, ${before.choices.length} downloadable — [${before.choices.map((c) => c.label).join(', ')}]`
    )

    const list = await hooks.qualities(window)
    check(
      'reads-the-players-qualities',
      list.levels.length > 0,
      list.levels.length > 0
        ? `${list.levels.length} offered: [${list.levels.map((q) => `${q.label}${q.current ? '*' : ''}`).join(', ')}]`
        : `nothing readable — ${list.note ?? 'no note'}`
    )
    check(
      'can-switch',
      list.available,
      list.available ? 'the player exposes the call its own quality menu uses' : 'no way to set quality'
    )

    // The best one that is not already playing, which is the case that matters.
    const target = list.levels.find((quality) => !quality.current) ?? list.levels[0]
    if (!target) {
      check('has-a-target', false, 'no quality to switch to')
    } else {
      log.info(`quality probe: asking for ${target.label} (${target.level})`)
      const result = await hooks.request(window, target.level)
      check('switch-accepted', result.ok, result.ok ? `player reports "${result.now}"` : result.note)
      check(
        'player-actually-switched',
        result.now === target.level,
        `asked for ${target.level}, player reports ${result.now || 'nothing'}`
      )

      const after = await hooks.options(window)
      log.info(
        `quality probe: after switching, ${after.choices.length} downloadable — [${after.choices.map((c) => c.label).join(', ')}]`
      )
      // The one that decides whether this feature is worth having.
      check(
        'something-became-downloadable',
        after.choices.length > 0,
        after.choices.length > 0
          ? `${after.choices.length} download(s) available at the requested quality`
          : `nothing was captured even after switching — ${result.note}`
      )
      check(
        'more-than-before',
        after.choices.length >= before.choices.length,
        `${before.choices.length} before, ${after.choices.length} after`
      )
    }
  } catch (error) {
    check('ran', false, error instanceof Error ? error.message : String(error))
  }

  log.info(`quality probe: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
  if (process.env['SLASH_PROBE_EXIT']) app.quit()
}
