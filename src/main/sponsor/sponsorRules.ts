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
export function acceptCreative(creative: Creative): CreativeVerdict {
  if (creative.image !== '' && !creative.image.startsWith('data:image/')) {
    return { ok: false, reason: 'image is not a data: URL' }
  }
  if (!/^https:\/\//i.test(creative.clickUrl)) {
    return { ok: false, reason: 'click target is not https' }
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
