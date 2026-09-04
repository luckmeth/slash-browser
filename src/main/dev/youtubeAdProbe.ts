import { app } from 'electron'
import type { AppContext } from '../AppContext'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const TARGET = process.env['SLASH_YT_URL'] ?? 'https://www.youtube.com/watch?v=tDl-9_62s-w'

/** How long to actually watch for an advert to appear. */
const WATCH_MS = Number(process.env['SLASH_YT_WATCH_MS'] ?? '75000')

/**
 * Do adverts still play, and does our script change that?
 *
 * The previous version of this probe asked "is an advert on screen right now"
 * once, a few seconds after load, and reported PASS when the answer was no.
 * That was worthless: most of a video is not an ad break, so the check passed
 * on a page that would have shown an advert moments later. It declared the
 * feature fixed while it was not, and it was believed.
 *
 * Two changes make the answer mean something:
 *
 *  1. **Watch over time.** Poll for the whole of `WATCH_MS`, because an advert
 *     that appears at 0:20 is exactly the thing being measured.
 *  2. **Compare against the blocker switched off.** "No advert appeared" is
 *     only evidence if an advert *would* have appeared otherwise. Without that
 *     control run, a quiet video and a working blocker look identical — which
 *     is precisely how the earlier version passed against broken code.
 */
async function watchOnce(
  window: BrowserWindowController,
  label: string
): Promise<{ adSeen: boolean; played: boolean }> {
  const tabs = window.tabs
  let activeId = tabs.snapshot().activeTabId
  for (let i = 0; i < 40 && !activeId; i++) {
    await delay(250)
    activeId = tabs.snapshot().activeTabId
  }
  if (!activeId) {
    log.error(`yt-ad probe [${label}]: no tab`)
    return { adSeen: false, played: false }
  }

  tabs.navigate(activeId, TARGET)
  await delay(11_000)

  let contents = tabs.activeTab?.contents ?? null
  for (let i = 0; i < 20 && !contents; i++) {
    await delay(250)
    contents = tabs.activeTab?.contents ?? null
  }
  if (!contents) {
    log.error(`yt-ad probe [${label}]: no contents`)
    return { adSeen: false, played: false }
  }

  log.info(`yt-ad probe [${label}]: debugger attached = ${contents.debugger.isAttached()}`)

  // `autoplayPolicy: 'user-gesture-required'` is set on every page view, so a
  // scripted `play()` is refused however the call is flagged - Chromium wants a
  // real input event. This is the same lesson the auto-hide probe learned: some
  // things cannot be asserted into existence from JavaScript.
  const box = (await contents
    .executeJavaScript(
      `(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        const r = v.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`,
      true
    )
    .catch(() => null)) as { x: number; y: number } | null

  if (box) {
    contents.focus()
    contents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await delay(1500)
    log.info(`yt-ad probe [${label}]: clicked the player at ${box.x},${box.y}`)
  } else {
    log.warn(`yt-ad probe [${label}]: no video element to click`)
  }

  let adSeen = false
  let played = false
  const started = Date.now()
  while (Date.now() - started < WATCH_MS) {
    const live = tabs.activeTab?.contents
    if (!live) break

    // Keep asking until it actually moves. The first `play()` lands before the
    // player is ready more often than not, and a run where `currentTime` never
    // advances measures nothing at all - which is exactly how the previous
    // version of this probe reported a clean result on a video it never played.
    const time = await live
      .executeJavaScript(
        `(() => {
          const v = document.querySelector('video');
          if (!v) return -1;
          if (v.paused) { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}) }
          return v.currentTime;
        })()`,
        true
      )
      .catch(() => -1)
    if (typeof time === 'number' && time > 0.5) played = true
    const showing = await live
      .executeJavaScript(
        `(() => {
          const p = document.querySelector('#movie_player');
          return !!(p && p.classList.contains('ad-showing')) ||
                 !!document.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-badge__text');
        })()`,
        true
      )
      .catch(() => false)
    if (showing === true && !adSeen) {
      adSeen = true
      log.info(
        `yt-ad probe [${label}]: ADVERT ON SCREEN at +${Math.round((Date.now() - started) / 1000)}s`
      )
    }
    await delay(2000)
  }

  const live = tabs.activeTab?.contents
  if (live) {
    const state = await live
      .executeJavaScript(
        `(() => {
          const out = {};
          const d = Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse');
          out.accessorInstalled = !!(d && typeof d.get === 'function');
          const r = window.ytInitialPlayerResponse;
          if (r) {
            out.adFieldsLeft = ['adPlacements','playerAds','adSlots','adBreakHeartbeatParams']
              .filter((k) => k in r);
            out.ssap = !!(r.playerConfig && r.playerConfig.ssap);
          }
          const v = document.querySelector('video');
          out.videoTime = v ? Math.round(v.currentTime) : -1;
          out.styleInstalled = !!document.getElementById('slash-yt-ads');
          return out;
        })()`,
        true
      )
      .catch((error: unknown) => ({ error: String(error) }))
    log.info(`yt-ad probe [${label}]: adSeen=${adSeen} ${JSON.stringify(state)}`)
  }

  if (!played) {
    log.error(
      `yt-ad probe [${label}]: playback never started - this run proves nothing`
    )
  }
  return { adSeen, played }
}

export async function runYouTubeAdProbe(
  window: BrowserWindowController,
  context: AppContext
): Promise<void> {
  log.info(`yt-ad probe: watching ${TARGET} for ${WATCH_MS / 1000}s per run`)

  // Control first: blocker off, so we learn whether this video even serves an
  // advert to this account right now. Without that, a clean run proves nothing.
  await context.settings.update({ blockYouTubeVideoAds: false })
  await delay(800)
  const off = await watchOnce(window, 'blocker OFF')

  await context.settings.update({ blockYouTubeVideoAds: true })
  await delay(800)
  const on = await watchOnce(window, 'blocker ON')

  log.info('yt-ad probe: ================ RESULT ================')
  log.info(`yt-ad probe: blocker OFF -> advert seen: ${off.adSeen}`)
  log.info(`yt-ad probe: blocker ON  -> advert seen: ${on.adSeen}`)

  if (!off.played || !on.played) {
    log.error(
      'yt-ad probe: INVALID — the video never played, so no ad break could occur. ' +
        'Nothing here says anything about the blocker.'
    )
  } else if (!off.adSeen && !on.adSeen) {
    log.warn(
      'yt-ad probe: INCONCLUSIVE — the video played but no advert appeared even with ' +
        'the blocker off. This account/video served no ad, so the run cannot tell a ' +
        'working blocker from a quiet video. Try another video.'
    )
  } else if (off.adSeen && !on.adSeen) {
    log.info('yt-ad probe: PASS — an advert plays without the blocker and does not with it')
  } else if (on.adSeen) {
    log.error('yt-ad probe: FAIL — an advert played with the blocker on')
  }

  app.quit()
}
