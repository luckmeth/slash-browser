import type { BrowserWindowController } from '../windows/BrowserWindowController'
import type { AppContext } from '../AppContext'
import { createLogger } from '../logger'

const log = createLogger('SLASH_YT_TIMING_PROBE')

/**
 * Did the shield's setup win the race against the first page it protects?
 *
 * The report this exists for: **adverts play on the first YouTube video after a
 * fresh start, and on none of the videos after it.** That shape is the
 * signature of a race, not of a broken filter — something that is installed
 * lazily, misses the navigation that triggered it, and is then in place for
 * every navigation afterwards.
 *
 * The candidate is `ScriptletInjector`. Its whole install is asynchronous CDP
 * round trips, and hanging them off `did-start-navigation` means they run
 * *while* the page is already loading. YouTube asks for `/youtubei/v1/player`
 * almost immediately, so if `Fetch.enable` has not landed by then that response
 * is never paused and its ad breaks survive.
 *
 * This measures it rather than arguing about it, and it is deliberately capable
 * of reporting **INCONCLUSIVE**: a run where the page never asked for a player
 * response proves nothing at all, and saying PASS there would be exactly the
 * mistake `SLASH_YT_ADS_PROBE` made twice.
 */
interface TraceEntry {
  readonly event: string
  readonly detail: string | undefined
  readonly at: number
}

const WATCH_ONE = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
const WATCH_TWO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'

export async function runYouTubeTimingProbe(
  window: BrowserWindowController,
  context: AppContext
): Promise<void> {
  const trace: TraceEntry[] = []
  const started = Date.now()

  context.injector.onTrace = (event, detail) => {
    trace.push({ event, detail, at: Date.now() - started })
  }

  const report = (label: string): TraceEntry[] => {
    const rows = [...trace]
    trace.length = 0
    log.info(`--- ${label} ---`)
    if (rows.length === 0) log.info('  (nothing traced)')
    for (const row of rows) {
      log.info(`  +${String(row.at).padStart(5)}ms  ${row.event}${row.detail ? ` (${row.detail})` : ''}`)
    }
    return rows
  }

  const settle = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * The measurement that actually matters.
   *
   * A watch page carries its player data **in the HTML**, as
   * `ytInitialPlayerResponse` — the `/youtubei/v1/player` request the Fetch
   * filter watches for is not made on a normal navigation at all, which is why
   * nothing was ever paused. So what decides whether an advert plays is whether
   * the page-world script deleted those fields *before* the player read them.
   *
   * This asks the page what is left, which is the same question the user's eyes
   * were asking.
   */
  const adFields = async (label: string): Promise<string[] | null> => {
    const found = window.tabs.findById(tabId)
    const contents = found?.view?.webContents
    if (!contents || contents.isDestroyed()) {
      log.info(`  ad fields (${label}): no view`)
      return null
    }
    try {
      // The accessor is reported alongside the fields, because "a field is
      // still there" has two completely different meanings depending on it:
      // a strip that never installed, or a strip that installed and was
      // defeated. Reading only the fields cannot tell those apart, and
      // guessing between them is how this bug survived two rounds.
      const state = (await contents.executeJavaScript(
        `(() => {
           const d = Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse');
           const r = window.ytInitialPlayerResponse;
           return {
             accessorInstalled: !!(d && typeof d.get === 'function'),
             // The script adds this stylesheet unconditionally once its
             // hostname gate passes, so its presence separates "the script
             // never reached the page" from "the script ran and something
             // replaced its accessor afterwards". Those need opposite fixes.
             scriptRan: !!document.getElementById('slash-yt-ads'),
             present: !!r,
             looksLikePlayerResponse: !!(r && (r.streamingData || r.videoDetails || r.adPlacements)),
             ssap: !!(r && r.playerConfig && r.playerConfig.ssap),
             fields: r
               ? ['adPlacements','playerAds','adSlots','adBreakHeartbeatParams']
                   .filter((k) => r[k] !== undefined)
               : ['(no ytInitialPlayerResponse)']
           };
         })()`,
        true
      )) as {
        accessorInstalled: boolean
        scriptRan: boolean
        present: boolean
        looksLikePlayerResponse: boolean
        ssap: boolean
        fields: string[]
      }
      const left = state.fields
      log.info(
        `  ad fields (${label}): ${left.length === 0 ? 'none left' : left.join(', ')}` +
          `  [ran=${state.scriptRan} accessor=${state.accessorInstalled}` +
          ` playerResponse=${state.looksLikePlayerResponse}` +
          ` ssap=${state.ssap}]`
      )
      return left
    } catch (error) {
      log.info(`  ad fields (${label}): could not read (${String(error)})`)
      return null
    }
  }

  /**
   * Did the warm-up leave a footprint in somebody's back history?
   *
   * The fix gives a rendererless tab a blank document so the shield has
   * something to install into. That is only acceptable if it is invisible: a
   * Back button that returns to a blank page instead of to where the user came
   * from is a worse bug than the one being fixed, and it is exactly the kind of
   * thing that is easy to reason yourself out of checking.
   */
  const history = (label: string): void => {
    const contents = window.tabs.findById(tabId)?.view?.webContents
    if (!contents || contents.isDestroyed()) {
      log.info(`  history (${label}): no view`)
      return
    }
    try {
      const entries = contents.navigationHistory.getAllEntries().map((entry) => entry.url)
      const blanks = entries.filter((url) => url === 'about:blank').length
      log.info(
        `  history (${label}): canGoBack=${contents.navigationHistory.canGoBack()} ` +
          `index=${contents.navigationHistory.getActiveIndex()} ` +
          `entries=${entries.length} about:blank=${blanks}`
      )
      for (const [index, url] of entries.entries()) {
        log.info(`    [${index}] ${url.slice(0, 90)}`)
      }
      if (blanks > 0) {
        log.info('  WARNING: the warm-up left a blank entry in the back history.')
      }
    } catch (error) {
      log.info(`  history (${label}): could not read (${String(error)})`)
    }
  }

  const describe = (label: string): void => {
    // Whether the page actually loaded is the difference between "the filter
    // missed it" and "there was nothing to miss". Reported explicitly, because
    // an empty trace means both and a probe that cannot tell them apart is
    // worth nothing.
    const found = window.tabs.findById(tabId)
    const snapshot = found?.snapshot
    log.info(
      `  page state (${label}): url=${snapshot?.url ?? 'gone'} ` +
        `title=${JSON.stringify(snapshot?.title ?? '')}`
    )
  }

  log.info('cold start: loading the first watch page')
  const tab = window.tabs.create({ url: WATCH_ONE })
  const tabId = tab.id
  await settle(20_000)
  const first = report('first navigation (cold)')
  describe('cold')
  history('cold')
  const coldFields = await adFields('cold')

  log.info('loading a second watch page in the same tab')
  window.tabs.navigate(tabId, WATCH_TWO)
  await settle(20_000)
  const second = report('second navigation (warm)')
  describe('warm')
  history('warm')
  const warmFields = await adFields('warm')

  // The path the report actually came from.
  //
  // "Close all tabs, close the browser, reopen it, go to YouTube" reopens with
  // *restored* tabs, and restoring rebuilds the view and replays the saved
  // navigation history. That branch used to `return` before the shield seam
  // entirely. Hibernating and waking is the same code path — `buildView` with a
  // saved navigation — and is the closest thing to a browser restart that can
  // be exercised inside one process.
  log.info('hibernating and waking the tab: the restored-tab path')
  window.tabs.hibernate(tabId, null)
  await settle(1_000)
  window.tabs.activate(tabId)
  await settle(20_000)
  const restored = report('third navigation (restored from hibernation)')
  describe('restored')
  history('restored')
  const restoredFields = await adFields('restored')

  const installedAt = (rows: TraceEntry[]): number | null =>
    rows.find((r) => r.event === 'script-installed')?.at ?? null

  log.info('==========================================================')
  log.info(`script installed on the cold navigation at: ${installedAt(first) ?? 'never'}ms`)
  log.info(`script installed on the restored navigation at: ${installedAt(restored) ?? 'never (already installed)'}ms`)
  log.info(`ad fields left after restore: ${restoredFields === null ? 'unreadable' : restoredFields.length === 0 ? 'none' : restoredFields.join(', ')}`)
  log.info(`player responses paused (cold/warm): ${first.filter((r) => r.event === 'player-paused').length}/${second.filter((r) => r.event === 'player-paused').length}`)

  // A run that could not read the page proves nothing either way.
  if (coldFields === null || warmFields === null) {
    log.info('VERDICT: INCONCLUSIVE — the page could not be read, so neither')
    log.info('  navigation was actually measured.')
    context.injector.onTrace = null
    return
  }
  if (coldFields[0] === '(no ytInitialPlayerResponse)') {
    log.info('VERDICT: INCONCLUSIVE — the cold page carried no player response,')
    log.info('  so there was nothing for the strip to act on. This did not test')
    log.info('  what it was written to test.')
    context.injector.onTrace = null
    return
  }

  if (coldFields.length === 0 && warmFields.length === 0) {
    log.info('VERDICT: PASS — the ad fields were gone on the cold navigation as')
    log.info('  well as the warm one, so the strip is installed before the first')
    log.info('  page reads its player data.')
  } else if (coldFields.length > 0 && warmFields.length === 0) {
    log.info('VERDICT: FAIL — the cold navigation still carried ' + coldFields.join(', '))
    log.info('  and the warm one carried none. The strip is installing after the')
    log.info('  first page has already read its player data, which is exactly')
    log.info('  why adverts play on the first video and on no video after it.')
  } else {
    log.info(`VERDICT: MIXED — cold=[${coldFields.join(', ')}] warm=[${warmFields.join(', ')}]`)
  }

  context.injector.onTrace = null
}
