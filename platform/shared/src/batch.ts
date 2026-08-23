/**
 * The batch every copy of Slash downloads.
 *
 * Shape must match `SponsorBatchSchema` in the browser
 * (`src/shared/types/sponsor.ts`) exactly. The browser parses the whole batch
 * or ignores the whole batch — there is no partial application — so a field
 * that drifts here takes every advert off every start page at once, silently.
 */

/** Refetch interval the browser honours. Kept in step with `MIN_FETCH_INTERVAL_MS`. */
export const BATCH_TTL_MS = 6 * 60 * 60 * 1000

/**
 * How far ahead of now a campaign is included in the batch.
 *
 * A browser fetching now must already be holding anything that starts before it
 * next fetches, because it will not ask again in between. Two intervals of slack
 * covers a machine that misses a refresh entirely — the schedule is enforced on
 * the reader's own clock, so sending a campaign early costs nothing but bytes.
 */
export const BATCH_LOOKAHEAD_MS = 2 * BATCH_TTL_MS

export interface BatchTile {
  id: string
  sponsor: string
  headline: string
  body: string
  /** A data: URL, or ''. Never a link — see `acceptCreative`. */
  image: string
  clickUrl: string
  /** Where it goes. `background` is the exclusive new-tab takeover. */
  placement: 'tile' | 'background'
  startsAt: number | null
  endsAt: number | null
}

/** Which placement tier maps to which rendering. */
export function placementFor(tier: string): 'tile' | 'background' {
  return tier === 'newtab_background' ? 'background' : 'tile'
}

export interface Batch {
  expiresAt: number
  tiles: BatchTile[]
}

export interface CampaignRow {
  id: string
  title: string
  description: string | null
  destination_link: string
  starts_at: string
  ends_at: string
  placement_tier?: string
  /**
   * PostgREST returns an embedded relation as an object or as a single-element
   * array depending on how it infers the relationship, and the two are not
   * distinguishable from the query. Accepting both is not defensiveness: read
   * the array shape as an object and every sponsor name silently becomes
   * undefined, every creative fails `acceptCreative`, and the batch empties for
   * everyone with nothing logged that names the cause.
   */
  advertisers: { company_name: string } | { company_name: string }[] | null
}

/** First of an embedded relation, however PostgREST chose to shape it. */
export function embedded<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/**
 * Whether a campaign belongs in a batch built at `now`.
 *
 * Includes campaigns that have not started yet: the browser holds the window
 * and starts them itself. That is the whole reason an advert can be sold by the
 * hour against a six-hourly fetch.
 */
export function belongsInBatch(
  campaign: { starts_at: string; ends_at: string },
  now: number
): boolean {
  const starts = Date.parse(campaign.starts_at)
  const ends = Date.parse(campaign.ends_at)
  if (Number.isNaN(starts) || Number.isNaN(ends)) return false
  return ends > now && starts < now + BATCH_LOOKAHEAD_MS
}

/**
 * One row plus its already-inlined image.
 *
 * The image arrives as a data URL because the caller read it out of storage and
 * encoded it. It is emphatically not a link: a remote `<img src>` would be a
 * request to us every time the advert appeared, on every machine — which is the
 * per-impression tracking the browser refuses to make, and the reason it drops
 * any creative whose image is not a data URL.
 */
export function toBatchTile(campaign: CampaignRow, imageDataUrl: string): BatchTile {
  return {
    id: campaign.id,
    sponsor: embedded(campaign.advertisers)?.company_name ?? '',
    headline: campaign.title,
    body: campaign.description ?? '',
    image: imageDataUrl,
    clickUrl: campaign.destination_link,
    placement: placementFor(campaign.placement_tier ?? ''),
    startsAt: Date.parse(campaign.starts_at),
    endsAt: Date.parse(campaign.ends_at)
  }
}

export function buildBatch(tiles: BatchTile[], now: number): Batch {
  return { expiresAt: now + BATCH_TTL_MS, tiles }
}

export type CreativeVerdict = { ok: true } | { ok: false; reason: string }

/**
 * The browser's own acceptance rules, applied before anything is served.
 *
 * Copied deliberately rather than imported — the browser is a separate
 * codebase. Enforced here so a campaign cannot sit approved in the queue and
 * then be dropped by every reader for a reason nobody in the portal can see.
 */
export function acceptCreative(tile: BatchTile): CreativeVerdict {
  if (tile.sponsor.trim() === '') return { ok: false, reason: 'no sponsor name' }
  if (tile.headline.trim() === '') return { ok: false, reason: 'no headline' }
  if (tile.image !== '' && !tile.image.startsWith('data:image/')) {
    return { ok: false, reason: 'image is not a data: URL' }
  }
  if (!/^https:\/\//i.test(tile.clickUrl)) {
    return { ok: false, reason: 'click target is not https' }
  }
  if (tile.startsAt !== null && tile.endsAt !== null && tile.endsAt <= tile.startsAt) {
    return { ok: false, reason: 'campaign ends before it starts' }
  }
  return { ok: true }
}

/** Bytes a data URL costs in the batch, near enough to reason about. */
export function encodedSize(dataUrl: string): number {
  return dataUrl.length
}

/**
 * Guard against a batch nobody wants to download.
 *
 * Every live creative's image ships inline to every reader, so concurrency is
 * not just an inventory question — it is the size of a file every user fetches.
 * Tiles beyond the cap are dropped rather than truncating the JSON, and the
 * caller is told, because a silently short batch is an advertiser wondering why
 * they were not delivered.
 */
export function capBatchSize(
  tiles: BatchTile[],
  maxBytes: number
): { kept: BatchTile[]; dropped: BatchTile[] } {
  const kept: BatchTile[] = []
  const dropped: BatchTile[] = []
  let total = 0
  for (const tile of tiles) {
    const size = encodedSize(tile.image)
    if (total + size > maxBytes && kept.length > 0) {
      dropped.push(tile)
      continue
    }
    total += size
    kept.push(tile)
  }
  return { kept, dropped }
}
