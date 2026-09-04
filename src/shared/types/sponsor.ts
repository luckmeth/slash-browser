import { z } from 'zod'

/**
 * A sponsored tile, as the start page renders it.
 *
 * Everything needed to draw it is already on the machine — including the image,
 * inlined as a data URL when the batch was fetched. Showing a tile therefore
 * makes **no network request at all**, which is what keeps a sponsor from
 * learning when or how often it was seen.
 */
/**
 * Where a creative may go.
 *
 * Declared once and referenced by both the stored-tile schema and the batch
 * schema. They used to carry their own copies of this list, and the moment a
 * placement was added to one the other silently rejected **the entire batch** —
 * not the single unknown creative, the whole fetch — so every campaign
 * disappeared at once and the only evidence was one line in a log.
 */
export const PLACEMENTS = ['tile', 'banner', 'background', 'notice', 'rail'] as const

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
   * Where this creative goes.
   *
   * Four shapes, priced by how much attention each takes:
   *
   *  - `background` — the whole new-tab backdrop. Exclusive, and dearest of
   *    the start-page formats.
   *  - `banner` — a wide panel on the start page. Visible without owning it.
   *  - `tile` — the small labelled card.
   *  - `rail` — a card in the empty gutter beside the start page's content
   *    column. Two can run at once, left and right. Cheapest of the start-page
   *    formats: it uses space that was otherwise blank, and it is the first
   *    thing dropped on a narrow window.
   *  - `notice` — a dismissible strip in the browser's **own chrome** while
   *    somebody is browsing. Never inside a web page: injecting adverts into
   *    pages is the exact behaviour this browser blocks, and doing it ourselves
   *    would make the product adware. Rarest and dearest.
   *
   * Defaults to `tile`, so a batch written before this existed keeps rendering
   * exactly as it did rather than becoming a takeover nobody sold.
   */
  placement: z.enum(PLACEMENTS).default('tile'),
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
  /**
   * The creative taking over the new-tab backdrop, or null.
   *
   * Separate from `tile` because it is a different placement sold at a
   * different rate, and because it is **exclusive**: there is no rotation to
   * advance, only the one campaign whose window covers now.
   */
  background: SponsoredTileSchema.nullable(),
  /** The wide panel on the start page, or null. */
  banner: SponsoredTileSchema.nullable(),
  /** The creative for a browsing notice, or null. Cadence decides *when*. */
  notice: SponsoredTileSchema.nullable(),
  /**
   * Up to two creatives for the gutters beside the start page, left then right.
   *
   * An array rather than two fields because the placement is sold as a pair of
   * equivalent slots — which side a campaign lands on is not something anybody
   * buys, and making it a field would imply it was.
   */
  rails: z.array(SponsoredTileSchema).max(2).default([]),
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
      placement: z.enum(PLACEMENTS).default('tile'),
      /** Unix ms. Omit both for a campaign with no schedule. */
      startsAt: z.number().nullable().default(null),
      endsAt: z.number().nullable().default(null)
    })
  )
})
export type SponsorBatch = z.infer<typeof SponsorBatchSchema>
