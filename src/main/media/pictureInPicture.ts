import type { WebContents } from 'electron'
import { createLogger } from '../logger'

const log = createLogger('pip')

/**
 * Picture-in-picture, driven from the browser rather than the page.
 *
 * Chromium already implements PiP; what a page cannot do is offer it when the
 * site's own player has no button — which is most players that are not YouTube.
 * So the request is made here, on the user's behalf.
 *
 * **This runs script in the page's main world**, which `CLAUDE.md` treats as a
 * capability to keep narrow rather than a line nobody crosses. Two things keep
 * it narrow: the script is a fixed string with nothing interpolated into it, and
 * it only ever calls an API the page could already have called itself. It reads
 * nothing out of the page and sends nothing back beyond a success flag.
 *
 * `executeJavaScript(code, true)` marks it as user-initiated. Chromium requires a
 * transient user activation for `requestPictureInPicture`, and without that flag
 * the call is rejected — which looks exactly like the feature not working.
 */

export type PipOutcome = 'entered' | 'exited' | 'no-video' | 'unsupported' | 'refused'

/**
 * Puts the most plausible video into PiP, or takes it back out.
 *
 * "Most plausible" is the largest video that is actually playing; failing that,
 * simply the largest. A page can hold several — a hero background loop, an
 * advert, and the thing the user came for — and picking the first in document
 * order reliably chooses the wrong one.
 */
const SCRIPT = `(() => {
  try {
    if (!document.pictureInPictureEnabled) return 'unsupported'
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture()
      return 'exited'
    }
    const videos = [...document.querySelectorAll('video')].filter(
      (video) => video.readyState > 0 && !video.disablePictureInPicture
    )
    if (videos.length === 0) return 'no-video'
    const area = (video) => video.videoWidth * video.videoHeight
    const playing = videos.filter((video) => !video.paused && !video.ended)
    const pool = playing.length > 0 ? playing : videos
    const best = pool.reduce((a, b) => (area(b) > area(a) ? b : a))
    best.requestPictureInPicture()
    return 'entered'
  } catch {
    return 'refused'
  }
})()`

export async function togglePictureInPicture(contents: WebContents | null): Promise<PipOutcome> {
  if (!contents || contents.isDestroyed()) return 'no-video'
  try {
    // `true` marks this as a user gesture. Chromium refuses
    // requestPictureInPicture without a transient activation, and the refusal is
    // silent — indistinguishable from the feature simply not working.
    const outcome = (await contents.executeJavaScript(SCRIPT, true)) as PipOutcome
    return outcome
  } catch (error) {
    log.warn('picture-in-picture request failed', error)
    return 'refused'
  }
}

/** What to tell the user when nothing happened. Empty means it worked. */
export function pipMessage(outcome: PipOutcome): string {
  switch (outcome) {
    case 'entered':
    case 'exited':
      return ''
    case 'no-video':
      return 'There is no video on this page to pop out.'
    case 'unsupported':
      return 'This page does not allow picture-in-picture.'
    case 'refused':
      return 'The video refused to pop out. Some players block it.'
  }
}
