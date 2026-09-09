import type { WebContents } from 'electron'
import { createLogger } from '../logger'

const log = createLogger('shield')

/**
 * Does the page-world ad strip actually run?
 *
 * **Why this exists.** The strip stopped running entirely for a while, and
 * nothing in the product was capable of noticing. `Page.enable` had been removed
 * as an optimisation; Chromium wires up document-start injection as part of
 * enabling that domain, so `addScriptToEvaluateOnNewDocument` **resolved
 * successfully and the script never ran**. Every signal available said the
 * feature was working: the protocol replied, the log said "installed 3
 * script(s)", the settings screen said the blocker was on. Adverts played.
 *
 * The general lesson — *a command resolving is not the same as the command
 * having an effect* — is not something a unit test can hold, because the fault
 * was in delivery rather than in the script. The only check that separates the
 * two is to ask the page itself. That is what this does, and it is why the
 * answer is surfaced in Settings rather than kept in a log nobody reads.
 *
 * **What it costs.** One `executeJavaScript` returning a boolean, at most once
 * per session, and only on a site where the strip is supposed to have run.
 * Principle 1 forbids adding latency to the browsing path, so this runs after
 * `did-finish-load` rather than during a navigation, and never runs twice.
 */
export type ShieldVerdict = 'unknown' | 'verified' | 'failed' | 'off'

export interface ShieldVerification {
  readonly verdict: ShieldVerdict
  /** When the check ran, or null if it never has this session. */
  readonly at: number | null
  /** The host it was checked against, for a UI that should not be vague. */
  readonly host: string | null
}

/**
 * The marker the strip leaves behind.
 *
 * Deliberately something the script already does for its own reasons — it
 * injects this stylesheet to hide YouTube's ad containers — rather than a flag
 * added for the benefit of this check. A dedicated marker would be a
 * page-detectable fingerprint on every YouTube page, which is a real cost to
 * pay for a diagnostic.
 */
const MARKER_ID = 'slash-yt-ads'

/** Reading a boolean out of the page. Kept to one expression on purpose. */
const PROBE_SOURCE = `!!document.getElementById(${JSON.stringify(MARKER_ID)})`

/**
 * Whether the strip is expected to have run on this address.
 *
 * Must agree with the script's own hostname gate, which is why both are anchored
 * suffix matches rather than substring ones: `youtube.com.evil.test` is not
 * YouTube, and a check that thought it was would report a failure on every visit
 * to it.
 */
export function expectsStrip(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host === 'youtube.com' ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube.com') ||
      host.endsWith('.youtube-nocookie.com')
    )
  } catch {
    return false
  }
}

/**
 * Turns a raw answer into a verdict.
 *
 * Pure and separately tested, because "we could not read the page" and "the
 * script did not run" are different facts and reporting the first as the second
 * would make this check worse than not having one — a browser that cries wolf
 * about its own ad blocker teaches people to ignore it.
 */
export function verdictFor(options: {
  enabled: boolean
  ran: boolean | null
}): ShieldVerdict {
  if (!options.enabled) return 'off'
  if (options.ran === null) return 'unknown'
  return options.ran ? 'verified' : 'failed'
}

export class ShieldVerifier {
  private state: ShieldVerification = { verdict: 'unknown', at: null, host: null }

  /** One check per session. The fault this catches is not intermittent. */
  private checked = false

  constructor(
    private readonly enabled: () => boolean,
    private readonly onChanged: (state: ShieldVerification) => void
  ) {}

  current(): ShieldVerification {
    return this.state
  }

  /**
   * Lets the next page load check again.
   *
   * Called when the shield's settings change, because the previous verdict was
   * about a different configuration and showing it afterwards would be stale in
   * the one way that matters.
   */
  reset(): void {
    this.checked = false
    this.publish({ verdict: this.enabled() ? 'unknown' : 'off', at: null, host: null })
  }

  /** Called after a page finishes loading. Does nothing almost every time. */
  async notePageLoaded(contents: WebContents, url: string): Promise<void> {
    if (this.checked) return
    if (!expectsStrip(url)) return

    if (!this.enabled()) {
      this.checked = true
      this.publish({ verdict: 'off', at: Date.now(), host: hostOf(url) })
      return
    }

    this.checked = true
    const ran = await this.askPage(contents)
    const verdict = verdictFor({ enabled: true, ran })
    this.publish({ verdict, at: Date.now(), host: hostOf(url) })

    if (verdict === 'failed') {
      // Loud, because this is the state that shipped silently for weeks.
      log.warn(
        `the YouTube ad strip did not run on ${hostOf(url) ?? 'this page'} — ` +
          'adverts will play. See SLASH_YT_TIMING_PROBE.'
      )
    } else {
      log.info(`ad strip verified on ${hostOf(url) ?? 'a page'}`)
    }
  }

  private async askPage(contents: WebContents): Promise<boolean | null> {
    if (contents.isDestroyed()) return null
    try {
      // `true` for a user gesture is deliberately **not** passed: this reads a
      // boolean and must never be able to trigger anything gesture-gated.
      const answer = await contents.executeJavaScript(PROBE_SOURCE)
      return typeof answer === 'boolean' ? answer : null
    } catch (error) {
      // A page that refuses to be read proves nothing either way, and saying so
      // is the whole reason `unknown` exists as a verdict.
      log.debug('could not read the shield marker', error)
      return null
    }
  }

  private publish(state: ShieldVerification): void {
    this.state = state
    this.onChanged(state)
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}
