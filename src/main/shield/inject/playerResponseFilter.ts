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

/**
 * The endpoints that carry them.
 *
 * `player` was the only one for a long time and it was not enough: an advert
 * played on a watch page reached by clicking a related video, which is an
 * in-page navigation whose player data arrives from innertube rather than in
 * fresh HTML. `next` carries the slot list beside the video and
 * `reel_watch_sequence` carries the Shorts one — uBlock prunes an `isAd` flag
 * out of exactly that response, which is how it stops Shorts adverts.
 *
 * Still a short list, and deliberately: every pattern here is a response the
 * browser pauses and buffers, so this is a cost paid on real navigations. The
 * cheap text test in `stripPlayerResponse` means a paused response with no ad
 * field in it is continued without being parsed at all.
 */
export const PLAYER_URL_PATTERNS = [
  '*youtubei/v1/player*',
  '*youtubei/v1/next*',
  '*youtubei/v1/reel/reel_watch_sequence*'
] as const

/** Kept for callers that want the primary one by name. */
export const PLAYER_URL_PATTERN = PLAYER_URL_PATTERNS[0]

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

  // Cheap reject before parsing megabytes of JSON: a response carrying ad
  // breaks always names at least one of these somewhere in its text.
  if (!MARKERS.some((marker) => text.includes(`"${marker}"`))) {
    return { body: null, removed: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON, or truncated. Left exactly as it arrived.
    return { body: null, removed: [] }
  }

  if (!parsed || typeof parsed !== 'object') return { body: null, removed: [] }

  const removed = pruneAdFields(parsed)
  if (removed.length === 0) return { body: null, removed: [] }

  return { body: Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64'), removed }
}

/**
 * Everything the cheap pre-test looks for.
 *
 * The ad fields plus the two nested markers, because a response can carry
 * `playerConfig.ssap` or an `isAd` flag without naming any of the top-level
 * fields — and rejecting it on the text test would mean never looking.
 */
const MARKERS = [...AD_FIELDS, 'ssap', 'isAd'] as const

/**
 * How deep to walk. Innertube responses nest heavily and this is not a search
 * for something hidden — everything being removed sits within a few levels of a
 * player response — so a ceiling keeps a pathological body from costing real
 * time on the browsing path.
 */
const MAX_DEPTH = 12

/**
 * Removes ad fields **wherever they appear**, not only at the top level.
 *
 * This was top-level-only, and that was the bug behind "adverts still play".
 * A `/youtubei/v1/player` response carries the player data at its root, so the
 * old code worked on a fresh page load — but the response to clicking a related
 * video nests it under `playerResponse`, and a body shaped
 * `{ playerResponse: { adPlacements: [...] } }` passed the text test, parsed
 * cleanly, matched nothing at the root and was **served untouched**. Nothing
 * failed; the advert simply played.
 *
 * uBlock Origin prunes `playerResponse.adPlacements` alongside the bare
 * `adPlacements` for the same reason. Walking is preferred here over a fixed
 * list of paths because the next shape YouTube nests it under does not need a
 * new rule.
 *
 * Returns the paths it removed, which is what the probe and the log report —
 * "removed adPlacements" and "removed playerResponse.adPlacements" are
 * different facts and only one of them is the interesting one.
 */
export function pruneAdFields(root: unknown): string[] {
  const removed: string[] = []

  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return

    if (Array.isArray(value)) {
      // Arrays are walked but never indexed into the path: `adSlots` inside the
      // 900th entry of a list is the same finding as inside the first, and a
      // log line naming an index would be noise.
      for (const entry of value) walk(entry, path, depth + 1)
      return
    }

    const record = value as Record<string, unknown>

    for (const field of AD_FIELDS) {
      if (field in record) {
        delete record[field]
        removed.push(path === '' ? field : `${path}.${field}`)
      }
    }

    // Server-stitched configuration hangs off playerConfig rather than sitting
    // at any level as a named field, so the loop above cannot reach it.
    const config = record['playerConfig']
    if (config && typeof config === 'object' && 'ssap' in (config as Record<string, unknown>)) {
      delete (config as Record<string, unknown>)['ssap']
      removed.push(path === '' ? 'playerConfig.ssap' : `${path}.playerConfig.ssap`)
    }

    for (const [key, child] of Object.entries(record)) {
      walk(child, path === '' ? key : `${path}.${key}`, depth + 1)
    }
  }

  walk(root, '', 0)
  return removed
}
