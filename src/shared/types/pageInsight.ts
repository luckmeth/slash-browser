import { z } from 'zod'

/**
 * Page Insight.
 *
 * Explains a page from what is actually on it: what it appears to be about, how
 * it is structured, where it links, whether it is promotional, and — on a
 * shopping page — what the price and its conditions are.
 *
 * **Everything here is read locally by the browser. No AI is involved.** That is
 * both a privacy property and an honesty constraint: because these are
 * heuristics over markup rather than a model's reading, the panel must not be
 * labelled "AI Analysis". It says what it detected and how, and every finding
 * carries the evidence it came from so the user can disagree with it.
 *
 * The distinction matters. A model can be asked what a page argues; markup can
 * only tell you what a page *declares*. This does the second, and says so.
 */

export const InsightSignalSchema = z.object({
  /** Short label, e.g. "Affiliate links". */
  label: z.string(),
  /** What was actually found. Never a verdict on the page's honesty. */
  detail: z.string(),
  /**
   * How firm the finding is.
   *
   * `declared` — the page itself said so in markup (rel="sponsored", JSON-LD).
   * `detected` — a pattern was matched in visible text or URLs.
   * Shown to the user, because "the page declares this is sponsored" and "the
   * word sponsored appears somewhere" are very different claims.
   */
  strength: z.enum(['declared', 'detected'])
})
export type InsightSignal = z.infer<typeof InsightSignalSchema>

export const OutlineEntrySchema = z.object({
  level: z.number().int().min(1).max(6),
  text: z.string()
})
export type OutlineEntry = z.infer<typeof OutlineEntrySchema>

export const ShoppingInsightSchema = z.object({
  productName: z.string().nullable(),
  /** As written on the page, currency included. Never recomputed or converted. */
  price: z.string().nullable(),
  availability: z.string().nullable(),
  /** Whether the page indicates a recurring charge rather than a one-off. */
  subscription: z.boolean(),
  /** Whether return or refund terms are mentioned at all. */
  mentionsReturns: z.boolean(),
  mentionsCancellation: z.boolean()
})
export type ShoppingInsight = z.infer<typeof ShoppingInsightSchema>

export const PageInsightSchema = z.object({
  url: z.string(),
  host: z.string(),
  title: z.string(),
  siteName: z.string().nullable(),
  /** The page's own summary where it publishes one, else its opening sentences. */
  summary: z.string(),
  wordCount: z.number().int(),
  readingMinutes: z.number().int(),
  /** Heading structure, which is the fastest way to see what a page covers. */
  outline: z.array(OutlineEntrySchema),
  /** Distinct external hosts linked, most linked first. */
  linkedHosts: z.array(z.string()),
  externalLinkCount: z.number().int(),
  /** Promotional, affiliate, urgency and sourcing findings. */
  signals: z.array(InsightSignalSchema),
  /** Present only when the page looks like a product page. */
  shopping: ShoppingInsightSchema.nullable(),
  /** Set when the page could not be read; the panel shows this instead. */
  note: z.string().nullable()
})
export type PageInsight = z.infer<typeof PageInsightSchema>
