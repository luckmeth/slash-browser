import type { WebContents } from 'electron'
import {
  analyseFormats,
  formatsNote,
  isExtractablePage,
  safeTitle,
  type MediaChoice
} from './pageFormats'
import { createLogger } from '../logger'

const log = createLogger('media')

export interface PageMedia {
  title: string
  choices: MediaChoice[]
  /**
   * Why the list is short or empty, when it is.
   *
   * Carried out of here rather than decided by the caller, because only this
   * layer knows the difference between "the page listed nothing" and "the page
   * listed twenty formats whose addresses are signed". Those need different
   * sentences, and getting it wrong sends somebody off to check whether the
   * feature is broken.
   */
  note: string | null
}

/**
 * Reads the formats a video page already lists for itself.
 *
 * ## Scope, deliberately narrow
 *
 * This runs a script in a page's own JavaScript world, which CLAUDE.md is
 * explicit about keeping rare. Three constraints hold it down:
 *
 *  - **Only on hostnames known to work.** `isExtractablePage` gates it, so the
 *    script never runs on a page it could not read anyway.
 *  - **Only when the user asks.** It fires when somebody opens the download
 *    picker, not on load, not on a timer, not to decide whether to show a chip.
 *  - **It only reads.** The script returns a value and changes nothing. No
 *    protection is decrypted or worked around; a video that is actually
 *    protected is refused here exactly as it is in `classifyMedia`.
 *
 * ## Why it exists at all
 *
 * `MediaSniffer` watches responses, and on YouTube that finds nothing offerable
 * — the media arrives in small byte ranges of a transport format, so a response
 * observer sees fragments rather than a file. The page meanwhile has every
 * format listed in a variable before playback starts. That is the difference
 * between a download button that appears and one that never does.
 */
export class PageMediaExtractor {
  /** Whether the picker should even try. Cheap: a hostname test. */
  canExtract(contents: WebContents | null): boolean {
    if (!contents || contents.isDestroyed()) return false
    return isExtractablePage(contents.getURL())
  }

  async extract(contents: WebContents | null): Promise<PageMedia | null> {
    if (!this.canExtract(contents) || !contents) return null

    try {
      const raw: unknown = await contents.executeJavaScript(EXTRACT_SCRIPT, true)
      if (!raw || typeof raw !== 'object') return null

      const data = raw as { title?: unknown; streamingData?: unknown }
      const analysis = analyseFormats(data.streamingData as never)
      const note = formatsNote(analysis)

      if (analysis.choices.length === 0 && note === null) {
        log.debug('page listed no formats at all')
        return null
      }
      if (analysis.choices.length === 0) {
        log.debug(`page listed ${analysis.signed} signed format(s), none offerable`)
      }

      return {
        title: safeTitle(typeof data.title === 'string' ? data.title : ''),
        choices: analysis.choices,
        note
      }
    } catch (error) {
      // A page that will not answer is not an error condition — it means the
      // picker falls back to what the network observer saw.
      log.debug('format extraction failed', error)
      return null
    }
  }
}

/**
 * The script, in the page's own world.
 *
 * Written as an expression that returns a plain object, so nothing is defined,
 * assigned or left behind. `ytInitialPlayerResponse` is a global the page sets
 * before the player starts; on a navigation within YouTube it can go stale, so
 * the newer per-player copy is preferred when it is there.
 *
 * Wrapped in its own try/catch because it runs in a document we do not control
 * and a throw would surface as a rejected promise for a feature the user merely
 * clicked a button for.
 */
export const EXTRACT_SCRIPT = `(() => {
  try {
    const player = document.querySelector('#movie_player');
    const fromPlayer =
      player && typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
    const response = fromPlayer || window.ytInitialPlayerResponse || null;
    if (!response || !response.streamingData) return null;

    const details = response.videoDetails || {};
    return {
      title: typeof details.title === 'string' ? details.title : document.title,
      streamingData: {
        formats: Array.isArray(response.streamingData.formats)
          ? response.streamingData.formats
          : [],
        adaptiveFormats: Array.isArray(response.streamingData.adaptiveFormats)
          ? response.streamingData.adaptiveFormats
          : []
      }
    };
  } catch {
    return null;
  }
})()`
