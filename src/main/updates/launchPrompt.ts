import type { UpdateState } from '@shared/types/updates'

/**
 * Whether to put the update in front of the user, rather than in a chip.
 *
 * The chip is how browsers normally do this, and the argument for it is good:
 * an update is not an emergency and a modal on launch is an interruption
 * somebody did not ask for. The argument against it is this project's own
 * history — a chip sat in the toolbar advertising 0.2.1 while the browser
 * underneath it had been unable to check for updates at all, and nobody
 * noticed, because a chip is exactly as easy to ignore as it is to show.
 *
 * So this is a deliberate trade, and worth naming: **an interruption once per
 * launch, in exchange for an update that cannot be missed**. Both halves are
 * bounded on purpose.
 *
 *  - **Once per launch.** Not once per check. The auto-check runs every six
 *    hours, and a dialog that seizes the window mid-browse because a timer
 *    fired would be a genuinely hostile thing to ship. Cancel means cancel
 *    until the browser is next opened.
 *  - **Never before the first check finishes.** The check is already delayed so
 *    it does not compete with first paint, and nothing here waits on the
 *    network: no feed, slow feed or failed feed all reach the same place, which
 *    is a browser that opened normally. Principle 1 says no feature may add
 *    latency to the browsing path, and a modal that gated startup on an HTTP
 *    request would break it outright.
 *  - **Only when there is something to install.** `up-to-date`, `error` and
 *    `no-channel` are not questions, so they are not asked.
 *
 * `downloading` counts because auto-download is on by default: by the time the
 * first status arrives the fetch may already have started, and waiting for
 * `ready` would mean the dialog appears minutes later, over whatever the user
 * had begun doing.
 */
export interface PromptInput {
  readonly state: UpdateState
  /** Whether this launch has already asked. Cancel sets it; nothing clears it. */
  readonly promptedThisLaunch: boolean
}

export function shouldPromptForUpdate({ state, promptedThisLaunch }: PromptInput): boolean {
  if (promptedThisLaunch) return false
  return state === 'update-available' || state === 'downloading' || state === 'ready'
}
