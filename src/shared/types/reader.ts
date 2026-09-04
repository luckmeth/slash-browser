import { z } from 'zod'

/**
 * Reader mode.
 *
 * The article is carried as **structured plain text**, never as HTML, and that
 * is a security decision rather than a stylistic one. Readability produces
 * sanitised markup, but the surface that renders it is our overlay document —
 * a privileged view holding the `window.browser` IPC bridge. Injecting
 * page-derived markup there would put a cross-site scripting bug one
 * sanitiser-bypass away from the whole privileged API. Blocks of text cannot
 * carry script, whatever the page does.
 *
 * The cost is honest and stated in the UI: no images, and inline links become
 * plain text.
 */

export const ReaderBlockSchema = z.object({
  kind: z.enum(['heading', 'paragraph', 'quote', 'code', 'list-item']),
  /** 1–6 for headings, ignored otherwise. */
  level: z.number().int().min(1).max(6).default(1),
  text: z.string()
})
export type ReaderBlock = z.infer<typeof ReaderBlockSchema>

export const ReaderArticleSchema = z.object({
  url: z.string(),
  title: z.string(),
  siteName: z.string().nullable(),
  byline: z.string().nullable(),
  /** Rounded minutes at 230 words per minute. */
  readingMinutes: z.number().int(),
  wordCount: z.number().int(),
  blocks: z.array(ReaderBlockSchema)
})
export type ReaderArticle = z.infer<typeof ReaderArticleSchema>

/**
 * Below this, a page is not an article and reader mode would make it worse.
 *
 * Offering a "reader view" of a dashboard or a search results page produces a
 * blank screen with a title on it, which reads as the feature being broken
 * rather than inapplicable.
 */
export const READER_MIN_WORDS = 120

export const ReaderResultSchema = z.object({
  article: ReaderArticleSchema.nullable(),
  /** Why there is no article, in plain language. Null when there is one. */
  reason: z.string().nullable()
})
export type ReaderResult = z.infer<typeof ReaderResultSchema>
