import { clipboard } from 'electron'
import { readOffer, type ClipboardOffer } from './clipboardOffer'
import { createLogger } from '../logger'

export type { ClipboardOffer } from './clipboardOffer'

const log = createLogger('clipboard')

/**
 * Noticing when you copy a download link.
 *
 * The one IDM behaviour people miss most: copy a URL anywhere — a chat window,
 * a text file, another browser — and the download manager offers to fetch it.
 *
 * ## Why this is written so defensively
 *
 * Reading the clipboard is reading *everything the user copies*: passwords out
 * of a password manager, account numbers, private messages. It is one of the
 * most invasive things an application can do quietly, and most software that
 * does it does not say so.
 *
 * So, three rules, all structural rather than promised:
 *
 *  - **Off unless switched on.** `watchClipboardForDownloads` defaults to false.
 *  - **Only when Slash is focused, never on a timer.** A background poll would
 *    read the clipboard of whatever application the user is actually working
 *    in. Checking on focus means Slash reads it at the moment the user has
 *    deliberately come back to the browser — which is also exactly when they
 *    would have pasted it themselves.
 *  - **Nothing is kept.** The text is tested and dropped. What is retained is a
 *    hash-free copy of the *one* address that produced an offer, purely so the
 *    same link is not offered twice in a row — and that is cleared when the
 *    feature is switched off.
 *
 * It also never reads anything that is not a plausible download. A clipboard
 * holding a password is not a URL, fails the first test, and is discarded
 * before anything else looks at it.
 */
export class ClipboardWatcher {
  /** The last address offered, so the same copy is not offered repeatedly. */
  private lastOffered = ''
  /** What was on the clipboard when we last looked, offered or not. */
  private lastSeen = ''

  constructor(
    private readonly enabled: () => boolean,
    private readonly onOffer: (offer: ClipboardOffer) => void
  ) {}

  /**
   * Called when a browser window takes focus.
   *
   * The whole trigger. There is deliberately no interval anywhere in this file.
   */
  check(): void {
    if (!this.enabled()) {
      // Switched off means forgotten, not paused.
      this.lastOffered = ''
      this.lastSeen = ''
      return
    }

    let text: string
    try {
      text = clipboard.readText()
    } catch (error) {
      // A clipboard held open by another application is normal and not worth
      // reporting as a failure.
      log.debug('could not read the clipboard', error)
      return
    }

    // Unchanged since the last look: nothing was copied, so there is nothing
    // new to offer, and re-offering a dismissed link would be nagging.
    if (text === this.lastSeen) return
    this.lastSeen = text

    const offer = readOffer(text)
    if (!offer) return
    if (offer.url === this.lastOffered) return

    this.lastOffered = offer.url
    this.onOffer(offer)
  }

  /** Forgets what was offered, so the next copy of it counts as new. */
  reset(): void {
    this.lastOffered = ''
    this.lastSeen = ''
  }
}
