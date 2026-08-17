import { z } from 'zod'

/**
 * Internet Time Machine — page watching.
 *
 * "Tell me when this changes" for a job posting, a price, a set of university
 * deadlines or a terms page. Checked when the user next visits the page, not by
 * polling it in the background: a browser quietly re-fetching a list of pages on
 * a timer is making outbound requests the user did not ask for, and it would show
 * up in someone's server logs as a bot.
 *
 * Only the previous version's normalised text is kept — enough to say *what*
 * changed, without becoming an archive of everything the user ever watched.
 */

export const PageChangeSchema = z.object({
  id: z.number().int(),
  at: z.number(),
  /** Plain-language summary: price movements first, then removals, then additions. */
  summary: z.string(),
  /** Excerpt of what disappeared. Capped — this is a notice, not a copy. */
  removed: z.string(),
  added: z.string(),
  seen: z.boolean()
})
export type PageChange = z.infer<typeof PageChangeSchema>

export const WatchedPageSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  title: z.string(),
  addedAt: z.number(),
  /** Null until the page has been visited again since being watched. */
  lastCheckedAt: z.number().nullable(),
  changes: z.array(PageChangeSchema)
})
export type WatchedPage = z.infer<typeof WatchedPageSchema>

export const WatchStatusSchema = z.object({
  /** Whether the page in the active tab is being watched. */
  watching: z.boolean(),
  /** Watched pages, most recently changed first. */
  pages: z.array(WatchedPageSchema),
  /** Unseen changes across every watched page, for a badge. */
  unseenCount: z.number().int()
})
export type WatchStatus = z.infer<typeof WatchStatusSchema>

/** Excerpt length stored per change. Long enough to read, short enough not to archive. */
export const CHANGE_EXCERPT_CHARS = 400
