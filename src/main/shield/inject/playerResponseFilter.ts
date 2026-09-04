/**
 * Stripping YouTube's ad breaks out of the response itself.
 *
 * The page-world script that removes `adPlacements` and friends works. This is
 * the same strip one layer down, in the network response, over the debugger
 * connection Slash already holds for the injector — and it exists because the
 * script has two ways of not being there at all.
 *
 * **A tab can end up unprotected.** Scripts are chosen once per debugger
 * attachment, so a tab attached while the feature was off kept nothing when it
 * was switched on. That is fixed, and it is the kind of thing that will happen
 * again in some other form: an attach that fails, DevTools taking the debugger,
 * a page that gets there first. This layer does not depend on the script.
 *
 * **A page owns its own realm.** Nothing stops a site restoring `JSON.parse`
 * after we patch it. Measured on a real watch page, YouTube does *not* do this
 * today — an earlier reading that said otherwise was a broken regex in the
 * probe, not a finding — but a defence that a page could undo whenever it chose
 * is a defence with an expiry date nobody controls. A response paused here
 * belongs to the browser: the page cannot see it, restore around it, or detect
 * it by inspecting its globals.
 *
 * This does the strip one layer down, in the network response, over the
 * debugger connection Slash already holds for the injector. The page cannot
 * restore a native to undo it, cannot see it, and cannot detect it by
 * inspecting its own globals.
 *
 * Kept deliberately narrow, because response interception is not free:
 *
 *  - **One URL pattern**: `youtubei/v1/player` (with a wildcard either side). That is the endpoint that
 *    carries ad breaks. Nothing else on YouTube is paused, and no other site
 *    is touched at all.
 *  - **Fail open, always.** Any error — a body that will not decode, a request
 *    that has already gone — continues the request untouched. A paused request
 *    that is never continued is a page that hangs forever, which is a far worse
 *    failure than an advert.
 *  - **The same field list** as the page script, so there is one answer to
 *    "what does Slash remove" rather than two that can drift.
 */

/** The fields that carry ad breaks. Shared with the page-world script. */
export const AD_FIELDS = [
  'adPlacements',
  'playerAds',
  'adSlots',
  'adBreakHeartbeatParams'
] as const

/** The endpoint that carries them. Everything else is left alone. */
export const PLAYER_URL_PATTERN = '*youtubei/v1/player*'

export interface StripOutcome {
  /** The body to serve, base64-encoded, or null to leave the response alone. */
  body: string | null
  /** Which fields were found and removed. For the log, and for the probe. */
  removed: string[]
}

/**
 * Removes ad breaks from one player response body.
 *
 * Pure, and takes the body as the base64 the debugger hands over, so the whole
 * decision is testable without a browser: this is the function that decides
 * what a user sees, and it is the one place a mistake would either leak an
 * advert or corrupt a response into a broken player.
 *
 * Returns `body: null` whenever it should not interfere — not JSON, not a
 * player response, nothing to remove — so the caller continues the request
 * rather than re-serving an identical body it has decoded and re-encoded for
 * no reason.
 */
export function stripPlayerResponse(base64Body: string, isBase64: boolean): StripOutcome {
  let text: string
  try {
    text = isBase64 ? Buffer.from(base64Body, 'base64').toString('utf8') : base64Body
  } catch {
    return { body: null, removed: [] }
  }

  // Cheap reject before parsing megabytes of JSON: a player response always
  // names at least one of these.
  if (!AD_FIELDS.some((field) => text.includes(`"${field}"`))) {
    return { body: null, removed: [] }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    // Not JSON, or truncated. Left exactly as it arrived.
    return { body: null, removed: [] }
  }

  if (!parsed || typeof parsed !== 'object') return { body: null, removed: [] }

  const removed: string[] = []
  for (const field of AD_FIELDS) {
    if (field in parsed) {
      delete parsed[field]
      removed.push(field)
    }
  }

  // Server-stitched configuration hangs off playerConfig rather than the top
  // level, so the loop above cannot reach it.
  const config = parsed.playerConfig as Record<string, unknown> | undefined
  if (config && typeof config === 'object' && 'ssap' in config) {
    delete config.ssap
    removed.push('playerConfig.ssap')
  }

  if (removed.length === 0) return { body: null, removed: [] }

  return { body: Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64'), removed }
}
