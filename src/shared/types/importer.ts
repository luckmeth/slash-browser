import { z } from 'zod'

/**
 * Importing from another browser.
 *
 * Without this, switching to Slash means abandoning your bookmarks and history,
 * which almost nobody will do however good the browser is. It is the difference
 * between a browser someone can try and one they can only look at.
 *
 * Scope is deliberately narrow and stated plainly: **bookmarks and history
 * only.** Saved passwords and cookies are not read. See `ChromiumImporter` for
 * why that is a decision rather than an omission.
 */

export const ImportSourceSchema = z.object({
  /** Stable id for this profile, safe to send back as "import this one". */
  id: z.string(),
  /** The browser, e.g. "Google Chrome". */
  browser: z.string(),
  /** The profile within it, e.g. "Person 1" — Chromium supports several. */
  profile: z.string(),
  /** Whether each kind of data was actually found on disk. */
  hasBookmarks: z.boolean(),
  hasHistory: z.boolean()
})
export type ImportSource = z.infer<typeof ImportSourceSchema>

export const ImportSummarySchema = z.object({
  bookmarksAdded: z.number().int(),
  /** Already present, so left alone rather than duplicated. */
  bookmarksSkipped: z.number().int(),
  historyAdded: z.number().int(),
  historyMerged: z.number().int(),
  /**
   * What went wrong, in plain language, or null.
   *
   * A partial import is reported as a success with a note rather than as a
   * failure: getting bookmarks across when history was locked is still worth
   * having, and telling someone "import failed" when half of it worked would
   * send them to do it again.
   */
  warning: z.string().nullable()
})
export type ImportSummary = z.infer<typeof ImportSummarySchema>

/** Cap on imported history rows, newest first. */
export const MAX_IMPORTED_HISTORY = 20_000
