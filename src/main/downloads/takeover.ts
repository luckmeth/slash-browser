/**
 * Whether Slash should take a download away from Chromium and accelerate it.
 *
 * This is the thing a download manager is actually *for*. Slash has had a
 * segmented engine — several connections per file, resumable, rate-limited,
 * retrying with backoff — since Phase 6, and until now nothing reached it
 * except downloads started from inside our own UI. Clicking a link on a page
 * got Chromium's single-connection downloader, which is why the browser had a
 * download manager that nobody could tell was there.
 *
 * Taking over means **cancelling Chromium's transfer and requesting the URL
 * again**, which is how every download manager works and is not free:
 *
 *  - It is a second request. For a static file that costs a few hundred
 *    milliseconds. For an endpoint that *does* something — generates a report,
 *    marks an invoice paid, consumes a one-use token — it could do that thing
 *    twice, and we cannot see from here which kind we are looking at.
 *  - Chromium does not tell us the request method, so a download produced by
 *    submitting a form is indistinguishable from one produced by a link. Asked
 *    again as a GET, it would fail or return the wrong thing.
 *
 * So the rule is deliberately conservative: take over only where the upside is
 * real and the downside is small. A large file is worth several connections and
 * is overwhelmingly likely to be a static asset; a 40 KB one finishes before
 * anybody notices and is exactly the shape of a form result.
 *
 * Pure so every one of those judgements is pinned by a test, because the
 * failure mode is a download that silently does not happen.
 */

/**
 * Below this, Chromium keeps the download.
 *
 * Four megabytes. Under that, splitting into connections saves less time than
 * the extra round trip costs, so a takeover would be pure risk for no gain.
 * Above it, the saving is the whole point of the feature.
 */
export const MIN_TAKEOVER_BYTES = 4 * 1024 * 1024

export interface TakeoverRequest {
  url: string
  /** `getTotalBytes()`, which is 0 or negative when the server did not say. */
  totalBytes: number
  /** The setting. Off means Chromium keeps everything. */
  enabled: boolean
  /**
   * Whether the user asked to choose a folder for every download.
   *
   * **No longer a reason to refuse.** It used to be: Chromium's save dialog was
   * the thing the setting promised and the engine had no equivalent, so turning
   * the setting on silently disabled the accelerator for every download. The
   * engine now asks first — see `AppContext`'s `accelerate` hook — so the
   * preference and the acceleration are no longer a choice between two things.
   *
   * Kept in the request because a caller that has not been updated should still
   * compile, and because it is worth recording in the verdict.
   */
  askWhereToSave: boolean
}

export type TakeoverVerdict =
  | { take: true }
  | { take: false; because: string }

export function shouldTakeOver(request: TakeoverRequest): TakeoverVerdict {
  if (!request.enabled) return { take: false, because: 'acceleration is switched off' }

  if (!/^https?:\/\//i.test(request.url)) {
    // blob: and data: URLs exist only inside the page that made them, so there
    // is nothing here to request again.
    return { take: false, because: 'only http and https can be requested again' }
  }

  if (request.totalBytes <= 0) {
    // Unknown length means the engine cannot plan segments, so it would open one
    // connection — exactly what Chromium is already doing, at the price of an
    // extra request.
    return { take: false, because: 'the server did not say how big it is' }
  }

  if (request.totalBytes < MIN_TAKEOVER_BYTES) {
    return { take: false, because: 'small enough that another request would cost more than it saves' }
  }

  return { take: true }
}

/**
 * How much faster, roughly, for the confirmation dialog.
 *
 * Deliberately vague — "about 3× faster" rather than a time. Real throughput
 * depends on the server, the route and how many connections it will honour, and
 * a browser that promises "14 seconds" and takes ninety has told a small lie
 * that people remember.
 *
 * Returns null below two connections, where there is nothing to claim.
 */
export function speedClaim(connections: number, serverAllowsRanges: boolean): string | null {
  if (!serverAllowsRanges || connections < 2) return null
  return `up to ${connections}× faster`
}
