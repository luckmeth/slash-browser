import { z } from 'zod'

/**
 * A sponsored tile, as the start page renders it.
 *
 * Everything needed to draw it is already on the machine — including the image,
 * inlined as a data URL when the batch was fetched. Showing a tile therefore
 * makes **no network request at all**, which is what keeps a sponsor from
 * learning when or how often it was seen.
 */
export const SponsoredTileSchema = z.object({
  id: z.string(),
  /** Who paid. Shown to the user; not optional, because "Sponsored" alone hides who. */
  sponsor: z.string(),
  headline: z.string(),
  body: z.string().default(''),
  /** A data: URL. Remote URLs are rejected at fetch time — see SponsorService. */
  image: z.string().default(''),
  clickUrl: z.string(),
  /**
   * The campaign's window, in unix ms; null at either end means unbounded.
   *
   * Enforced on this machine rather than by refetching often enough to notice.
   * Campaigns are sold by the hour and a batch is fetched at most every six
   * hours, so asking the server "is it running yet" would need either a request
   * per tab -- the per-impression call this whole design exists to avoid -- or
   * hours of slack at both ends that somebody has paid for.
   */
  startsAt: z.number().nullable().default(null),
  endsAt: z.number().nullable().default(null)
})
export type SponsoredTile = z.infer<typeof SponsoredTileSchema>

/** What the start page needs to decide whether to draw a tile. */
export const SponsorStatusSchema = z.object({
  /** The user's switch. */
  enabled: z.boolean(),
  /** Whether an operator has configured an endpoint at all. */
  configured: z.boolean(),
  /** The tile to show now, or null. */
  tile: SponsoredTileSchema.nullable(),
  /** How many creatives are cached, for the settings panel. */
  cached: z.number().int(),
  /** Counts waiting to be reported, so the user can see exactly what is pending. */
  pendingReports: z.number().int()
})
export type SponsorStatus = z.infer<typeof SponsorStatusSchema>

/**
 * The batch an operator's endpoint must return.
 *
 * Documented in `docs/sponsored-tiles.md`. Kept deliberately small: a schema
 * with room for targeting parameters is a schema someone will eventually fill
 * in, and the point of batching is that there is nothing to target with.
 */
export const SponsorBatchSchema = z.object({
  /** Unix ms after which the batch should be refetched. */
  expiresAt: z.number(),
  tiles: z.array(
    z.object({
      id: z.string().min(1).max(120),
      sponsor: z.string().min(1).max(120),
      headline: z.string().min(1).max(200),
      body: z.string().max(400).default(''),
      /** data: URL only. An https: image would be a per-impression request. */
      image: z.string().max(2_000_000).default(''),
      clickUrl: z.string().url(),
      /** Unix ms. Omit both for a campaign with no schedule. */
      startsAt: z.number().nullable().default(null),
      endsAt: z.number().nullable().default(null)
    })
  )
})
export type SponsorBatch = z.infer<typeof SponsorBatchSchema>
