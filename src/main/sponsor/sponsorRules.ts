/**
 * The decisions behind sponsored tiles, as pure functions.
 *
 * Split out of `SponsorService` for the same reason `PopupPolicy` is split out
 * of `PopupGuard`: the service imports `electron`, which the test runner cannot
 * load, so anything left inside it can only ever be checked by launching the
 * whole browser. These are the rules where being wrong costs money or leaks
 * something, which makes them exactly the rules worth testing directly.
 */

export interface Creative {
  readonly id: string
  readonly image: string
  readonly clickUrl: string
  /** Unix ms, or null for unbounded. See `isLive`. */
  readonly startsAt?: number | null
  readonly endsAt?: number | null
}

/** A campaign's window. Null at either end means unbounded in that direction. */
export interface Scheduled {
  readonly startsAt: number | null
  readonly endsAt: number | null
}

/**
 * Whether a campaign is running at `now`.
 *
 * The window is carried in the batch and judged here, on the reader's own
 * machine, because the alternative is asking a server — and a request per tab
 * to find out whether an advert is due is precisely the per-impression call
 * that batching exists to avoid. It also means the schedule stays correct with
 * no network at all.
 *
 * Half-open: a campaign ending at 15:00 is not shown at 15:00. Two campaigns
 * bought back-to-back must not both be live for the instant they touch, or one
 * hour has been sold twice.
 */
export function isLive(window: Scheduled, now: number): boolean {
  if (window.startsAt !== null && now < window.startsAt) return false
  if (window.endsAt !== null && now >= window.endsAt) return false
  return true
}

/**
 * The creative due now, considering only campaigns currently running.
 *
 * Rotation is applied *after* filtering, so a batch holding future campaigns
 * still shows its live ones evenly rather than leaving gaps where a scheduled
 * one would have been.
 */
export function selectLive<T extends Scheduled>(
  tiles: readonly T[],
  rotation: number,
  now: number
): T | null {
  return selectTile(
    tiles.filter((tile) => isLive(tile, now)),
    rotation
  )
}

/**
 * Which creative is due, without advancing.
 *
 * Round-robin rather than random, so a small batch is shown evenly instead of
 * one creative dominating by luck — which is what a sponsor is paying for.
 *
 * Deliberately a *query*. An earlier version rotated as it read, so every
 * caller advanced the batch — including the click handler, which then compared
 * the clicked id against a different creative and billed a click that opened
 * nothing.
 */
export function selectTile<T>(tiles: readonly T[], rotation: number): T | null {
  if (tiles.length === 0) return null
  // Guards a negative or non-finite rotation, which would index out of bounds
  // and hand back undefined as though the batch were empty.
  const safe = Number.isFinite(rotation) ? Math.abs(Math.trunc(rotation)) : 0
  return tiles[safe % tiles.length] ?? null
}

export type CreativeVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Whether a creative from an operator's endpoint may be shown.
 *
 * Both rules exist to stop a tile becoming a tracking beacon:
 *
 *  - **Images must be `data:` URLs.** A remote `<img src>` is a request to the
 *    sponsor's server every single time the tile appears, which is a tracking
 *    pixel wearing a different hat and defeats batching entirely.
 *  - **Click targets must be `https:`.** Anything else sends the user somewhere
 *    that can be tampered with in transit.
 *
 * Enforced here rather than trusted to the renderer, because a creative that
 * slips through is not a rendering bug — it is a privacy promise broken.
 */
/**
 * Longest a creative's inlined image may be, as base64 characters.
 *
 * 700 KB encoded is roughly 512 KB of image — ample for a full-width backdrop
 * at sensible compression, and small enough that a full batch stays a
 * reasonable thing to hold in memory and write to a row.
 */
const MAX_IMAGE_CHARS = 700 * 1024

export function acceptCreative(creative: Creative): CreativeVerdict {
  if (creative.image !== '' && !creative.image.startsWith('data:image/')) {
    return { ok: false, reason: 'image is not a data: URL' }
  }
  // Inlined images are what keeps a creative from being a tracking pixel — the
  // batch is fetched once every few hours and nothing is requested per
  // impression — but inlining is also unbounded by construction. A batch is
  // parsed into memory and written to SQLite, so an operator who pastes a 40 MB
  // photograph would hand every copy of the browser a 40 MB row and a stall on
  // the start page. Capped at a size a real advert comfortably fits in.
  if (creative.image.length > MAX_IMAGE_CHARS) {
    return {
      ok: false,
      reason: `image is ${Math.round(creative.image.length / 1024)} KB encoded; the limit is ${Math.round(MAX_IMAGE_CHARS / 1024)} KB`
    }
  }
  if (!/^https:\/\//i.test(creative.clickUrl)) {
    return { ok: false, reason: 'click target is not https' }
  }
  // A window that ends before it starts can never run. Dropped here so an
  // operator sees it missing from the batch straight away, rather than spending
  // a day wondering why a campaign somebody paid for never appeared.
  const startsAt = creative.startsAt ?? null
  const endsAt = creative.endsAt ?? null
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    return { ok: false, reason: 'campaign ends before it starts' }
  }
  return { ok: true }
}

/**
 * Where aggregate counts are posted, given the batch endpoint.
 *
 * Resolved as a relative URL rather than string-concatenated. Appending
 * `/report` to `https://example.com/slash/tiles.json` produced
 * `…/tiles.json/report`, which is not a path any operator would have set up.
 * Standard relative resolution gives `https://example.com/slash/report`, which
 * is what they expect and what `docs/sponsored-tiles.md` documents.
 *
 * Returns null for an endpoint that is not a usable URL, so a malformed setting
 * means "do not report" rather than a thrown error on a background task.
 */
export function reportUrlFor(endpoint: string): string | null {
  const trimmed = endpoint.trim()
  if (trimmed === '') return null
  try {
    return new URL('report', trimmed).toString()
  } catch {
    return null
  }
}
