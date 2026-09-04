/**
 * Ceilings on what one pattern may expand to.
 *
 * A pattern is a few characters that becomes a list of requests to somebody
 * else's server, and the difference between `[1-50]` and `[1-5000000]` is three
 * keystrokes. Bounded here rather than at the call site, so no caller can
 * forget.
 */
export const BATCH_LIMITS = {
  /** URLs one pattern may produce. */
  maxUrls: 500,
  /** Ranges in one pattern. Two is `[1-9]` twice; more is almost certainly a typo. */
  maxRanges: 2
} as const

export interface BatchExpansion {
  readonly urls: string[]
  /** Plain language for the dialog: what this will do, or why it will not. */
  readonly note: string
  readonly error: boolean
}

/** `[1-50]`, `[01-50]`, `[a-z]`, `[A-Z]`. */
const RANGE = /\[(\d+)-(\d+)\]|\[([a-z])-([a-z])\]|\[([A-Z])-([A-Z])\]/

/**
 * Turns `file[1-50].jpg` into fifty addresses.
 *
 * The feature download managers call batch download, and the one place in this
 * engine where the user hands over a *rule* rather than a link. Two things
 * follow from that and both are encoded here rather than left to the caller.
 *
 * Zero-padding is taken from the pattern, not guessed: `[01-12]` means `01`
 * through `12` because that is what the person typed, and a server with
 * `image01.jpg` does not have `image1.jpg`. The width comes from the *first*
 * bound, so `[001-50]` pads to three.
 *
 * Descending ranges are accepted and produce a descending list. `[10-1]` is not
 * an error - it is somebody who wants the newest first, and refusing it would
 * be pedantry.
 *
 * Pure, so the expansion can be shown to the user before a single request is
 * made. Nothing here fetches anything.
 */
export function expandBatch(pattern: string): BatchExpansion {
  const trimmed = pattern.trim()
  if (trimmed === '') {
    return { urls: [], note: 'Enter an address.', error: true }
  }

  let ranges = 0
  let urls = [trimmed]

  for (;;) {
    const match = RANGE.exec(urls[0] ?? '')
    if (!match) break

    ranges += 1
    if (ranges > BATCH_LIMITS.maxRanges) {
      return {
        urls: [],
        note: `More than ${BATCH_LIMITS.maxRanges} ranges in one address is almost always a typo.`,
        error: true
      }
    }

    const values = match[1] !== undefined
      ? numbers(match[1], match[2]!)
      : letters(match[3] ?? match[5]!, match[4] ?? match[6]!)

    const next: string[] = []
    for (const url of urls) {
      for (const value of values) {
        next.push(url.replace(RANGE, value))
        if (next.length > BATCH_LIMITS.maxUrls) {
          return {
            urls: [],
            note: `That pattern makes more than ${BATCH_LIMITS.maxUrls} downloads. Narrow the range.`,
            error: true
          }
        }
      }
    }
    urls = next
  }

  if (ranges === 0) {
    return {
      urls: [trimmed],
      note: 'No range in this address, so it downloads as a single file.',
      error: false
    }
  }

  return {
    urls,
    note: `${urls.length} downloads, from ${urls[0]} to ${urls[urls.length - 1]}.`,
    error: false
  }
}

/** Inclusive, either direction, padded to the width the pattern asked for. */
function numbers(fromRaw: string, toRaw: string): string[] {
  const from = Number(fromRaw)
  const to = Number(toRaw)
  // The width the user wrote on the *first* bound. `[01-12]` pads, `[1-12]`
  // does not, and a server that serves `page01.jpg` has no `page1.jpg`.
  const width = fromRaw.length > 1 && fromRaw.startsWith('0') ? fromRaw.length : 0
  const step = from <= to ? 1 : -1
  const out: string[] = []
  for (let at = from; step > 0 ? at <= to : at >= to; at += step) {
    out.push(width > 0 ? String(at).padStart(width, '0') : String(at))
    if (out.length > BATCH_LIMITS.maxUrls) break
  }
  return out
}

function letters(from: string, to: string): string[] {
  const start = from.charCodeAt(0)
  const end = to.charCodeAt(0)
  const step = start <= end ? 1 : -1
  const out: string[] = []
  for (let at = start; step > 0 ? at <= end : at >= end; at += step) {
    out.push(String.fromCharCode(at))
    if (out.length > BATCH_LIMITS.maxUrls) break
  }
  return out
}
