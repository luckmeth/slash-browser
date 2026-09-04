import { z } from 'zod'

/**
 * A page saved to read later.
 *
 * Deliberately not a bookmark. A bookmark is a permanent reference you expect to
 * return to; a reading-list entry is a queue item you expect to consume once and
 * clear. Keeping them in one list is how bookmark folders turn into a graveyard
 * of things nobody ever meant to keep.
 */
export const ReadingItemSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  title: z.string(),
  faviconUrl: z.string().nullable(),
  addedAt: z.number(),
  /**
   * When it was read, or null.
   *
   * Marked rather than deleted, so finishing something is reversible and the
   * list can show what has been got through.
   */
  readAt: z.number().nullable()
})
export type ReadingItem = z.infer<typeof ReadingItemSchema>
