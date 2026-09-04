/**
 * Which failures are worth trying again, and how long to wait.
 *
 * The engine used to retry everything four times with backoff: a 404, a 403, a
 * refusal naming DRM and a dropped socket were all treated identically. That is
 * wrong in both directions. A file that is not there will still not be there in
 * eight seconds, so three extra attempts are three pointless requests and
 * roughly a minute of a progress bar that was never going to move. And a
 * `Retry-After` of thirty seconds is a server telling us exactly what it wants,
 * which a fixed backoff ignores.
 *
 * Pure, because every one of these judgements is a rule rather than a
 * behaviour, and the cost of getting one wrong is either a retry storm against
 * a struggling server or a download that gives up on a blip.
 */

/** What kind of failure this is, which decides whether to try again. */
export type FailureKind =
  /** It will not work later either. Fail now and say why. */
  | 'permanent'
  /** Worth another attempt after a wait. */
  | 'transient'
  /** No status and no recognised message: treated as transient, but bounded. */
  | 'unknown'

export interface FailureVerdict {
  readonly kind: FailureKind
  readonly retryable: boolean
  /** What the server asked us to wait, in ms, when it said. */
  readonly retryAfterMs: number | null
  /** Plain language, for the row in the list. */
  readonly reason: string
}

/**
 * Statuses that mean "not like this, not ever".
 *
 * 401 and 403 are here deliberately even though a credential *could* appear
 * later: retrying an authorization failure four times is how an account gets
 * rate-limited, and the honest response is to say the server refused rather
 * than to hammer it.
 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 405, 406, 410, 451])

/** Statuses that are the server having a moment rather than an opinion. */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509])

/**
 * Network-level failures worth another go.
 *
 * Matched on the text because that is all Chromium's net stack gives us through
 * `net.request`: `net::ERR_CONNECTION_RESET` arrives as a message, not a code.
 */
const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /EPIPE/i,
  /socket hang up/i,
  /net::ERR_CONNECTION/i,
  /net::ERR_TIMED_OUT/i,
  /net::ERR_NETWORK_CHANGED/i,
  /net::ERR_ADDRESS_UNREACHABLE/i,
  /net::ERR_INTERNET_DISCONNECTED/i,
  /timed? ?out/i
]

/**
 * Failures that are a decision, not an accident.
 *
 * A refusal naming encryption is this engine declining to work around a
 * service's protection. Retrying it would be trying the same refusal again, and
 * would read to the user as the browser struggling rather than declining.
 */
const PERMANENT_PATTERNS = [
  /encrypted/i,
  /live stream/i,
  /not currently supported/i,
  /does not work around/i,
  /Slash cannot/i,
  /Too many redirects/i,
  /no segments/i,
  /too large to read safely/i,
  /too deeply/i,
  /too many elements/i
]

/** `Retry-After: 120` or an HTTP date. Null when absent or nonsense. */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (header === null || header === undefined) return null
  const trimmed = header.trim()
  if (trimmed === '') return null

  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)

  const when = Date.parse(trimmed)
  if (!Number.isFinite(when)) return null
  // A date in the past means "now", not a negative wait.
  return Math.max(0, when - now)
}

/** What to do about a failure. */
export function classifyFailure(
  error: unknown,
  options: { retryAfter?: string | null; now?: number } = {}
): FailureVerdict {
  const status = (error as { status?: number } | null)?.status
  const message = error instanceof Error ? error.message : String(error ?? '')
  const retryAfterMs = parseRetryAfter(options.retryAfter, options.now)

  // A cancelled or paused transfer is neither: the caller stops before asking.
  if (typeof status === 'number') {
    if (PERMANENT_STATUSES.has(status)) {
      return {
        kind: 'permanent',
        retryable: false,
        retryAfterMs: null,
        reason: `The server refused this download (${status}). Trying again will not change that.`
      }
    }
    if (TRANSIENT_STATUSES.has(status)) {
      return {
        kind: 'transient',
        retryable: true,
        retryAfterMs,
        reason:
          status === 429
            ? 'The server asked us to slow down.'
            : `The server could not serve this right now (${status}).`
      }
    }
    // Any other 4xx is the client's fault and will not improve.
    if (status >= 400 && status < 500) {
      return {
        kind: 'permanent',
        retryable: false,
        retryAfterMs: null,
        reason: `The server refused this download (${status}).`
      }
    }
  }

  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: 'permanent', retryable: false, retryAfterMs: null, reason: message }
  }
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: 'transient', retryable: true, retryAfterMs, reason: message }
  }

  // Unrecognised. Retried, because a transfer that dies for an unclear reason is
  // usually the network, but bounded by the attempt cap like everything else.
  return { kind: 'unknown', retryable: true, retryAfterMs, reason: message }
}

/** Never wait longer than this, whatever the server asks. */
export const MAX_BACKOFF_MS = 60_000

/**
 * How long to wait before the next attempt.
 *
 * Exponential, capped, and **jittered**. The jitter is not decoration: several
 * downloads from one host failing together — which is what happens when a
 * connection drops — would otherwise retry in lockstep for ever, arriving as a
 * burst each time and looking exactly like an attack.
 *
 * A server's own `Retry-After` wins, because it knows and we are guessing.
 */
export function backoffMs(
  attempt: number,
  retryAfterMs: number | null = null,
  random: () => number = Math.random
): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, MAX_BACKOFF_MS)
  const base = 1000 * Math.pow(2, Math.max(0, attempt - 1))
  const capped = Math.min(base, MAX_BACKOFF_MS)
  // Full jitter over the interval, which spreads a thundering herd better than
  // a small wobble around the midpoint.
  return Math.round(capped * (0.5 + random() * 0.5))
}

/**
 * A wait that notices being cancelled.
 *
 * A download cancelled during a sixty-second backoff must stop then, not a
 * minute later — and it must not resurrect itself when the timer finally fires,
 * which is what a bare `setTimeout` does.
 */
export function cancellableDelay(
  ms: number,
  isCancelled: () => boolean,
  schedule: (fn: () => void, delay: number) => unknown = setTimeout
): Promise<'elapsed' | 'cancelled'> {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms
    const tick = (): void => {
      if (isCancelled()) {
        resolve('cancelled')
        return
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        resolve('elapsed')
        return
      }
      schedule(tick, Math.min(remaining, 250))
    }
    tick()
  })
}
