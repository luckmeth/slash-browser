import { z } from 'zod'

/**
 * Internet Cleanup Mode.
 *
 * Suppresses the layer of a page that exists to interrupt you — cookie walls,
 * newsletter overlays, sticky bars, floating chat widgets — without touching the
 * thing you came for.
 *
 * **Nothing is permanently modified.** Cleanup is injected CSS plus a small
 * amount of scroll-unlocking, held in the live document only. Reloading the page
 * restores it exactly, which is why "Restore" is cheap and why this can never
 * corrupt a site.
 */

export const CleanupModeSchema = z.enum([
  /** Overlays and scroll locks only — the things that block reading outright. */
  'light',
  /** Adds sticky bars, floating widgets, newsletter and cookie walls. */
  'balanced',
  /**
   * Adds anything positioned like an advertisement and pauses autoplaying media.
   *
   * Most likely of the three to take something the user wanted, which is why it
   * is opt-in per use and why Restore is offered beside it.
   */
  'aggressive'
])
export type CleanupMode = z.infer<typeof CleanupModeSchema>

export const CleanupResultSchema = z.object({
  applied: z.boolean(),
  mode: CleanupModeSchema,
  /** Elements hidden. Reported because a claim of "cleaned" with zero is a lie. */
  hidden: z.number().int(),
  /** Media elements paused. Only in aggressive. */
  paused: z.number().int(),
  /** True when the page had locked scrolling and cleanup released it. */
  scrollUnlocked: z.boolean(),
  /** Plain-language account of what happened, always set. */
  detail: z.string()
})
export type CleanupResult = z.infer<typeof CleanupResultSchema>

export const CleanupStatusSchema = z.object({
  /** Whether the page in the active tab currently has cleanup applied. */
  active: z.boolean(),
  mode: CleanupModeSchema,
  host: z.string(),
  /** Whether the user switched cleanup off for this site. */
  disabledForHost: z.boolean(),
  lastResult: CleanupResultSchema.nullable()
})
export type CleanupStatus = z.infer<typeof CleanupStatusSchema>
