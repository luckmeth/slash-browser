import { z } from 'zod'

/**
 * Why a result matched.
 *
 * Shown for every hit. A memory search that cannot explain itself is
 * indistinguishable from a guess, and the user has no way to tell a good match
 * from a coincidence.
 */
export const MatchReasonSchema = z.object({
  kind: z.enum(['keyword', 'title', 'url', 'semantic', 'recency']),
  detail: z.string()
})
export type MatchReason = z.infer<typeof MatchReasonSchema>

export const MemoryResultSchema = z.object({
  pageId: z.number().int(),
  url: z.string(),
  title: z.string(),
  siteName: z.string().nullable(),
  /** FTS5 snippet with the matched terms marked, or the stored excerpt. */
  snippet: z.string(),
  visitedAt: z.number(),
  /** Lower is better — BM25's own convention, normalised for display. */
  score: z.number(),
  reasons: z.array(MatchReasonSchema)
})
export type MemoryResult = z.infer<typeof MemoryResultSchema>

/**
 * A parsed query: the words to search for, plus any time window the user
 * expressed in words ("last Tuesday", "yesterday").
 *
 * Time parsing is deliberately deterministic rather than model-driven, so
 * "the article I read last week" works with AI switched off entirely.
 */
export const ParsedQuerySchema = z.object({
  /** Query with time words removed, ready for FTS. */
  terms: z.string(),
  /** Inclusive epoch-ms bounds, when the query named a period. */
  after: z.number().nullable(),
  before: z.number().nullable(),
  /** Human-readable form of the window, echoed back so the user can see it. */
  timeLabel: z.string().nullable()
})
export type ParsedQuery = z.infer<typeof ParsedQuerySchema>

export const MemoryStatsSchema = z.object({
  pageCount: z.number().int(),
  withContent: z.number().int(),
  oldestIndexedAt: z.number().nullable(),
  /** Whether the optional local embedding layer is available and enabled. */
  semanticAvailable: z.boolean(),
  semanticEnabled: z.boolean()
})
export type MemoryStats = z.infer<typeof MemoryStatsSchema>

/** Extraction result sent from the page. Untrusted — validated in main. */
export const ExtractedPageSchema = z.object({
  url: z.string(),
  title: z.string(),
  siteName: z.string().nullable(),
  excerpt: z.string(),
  /** Capped in the page before sending; a huge document must not cross IPC. */
  body: z.string(),
  wordCount: z.number().int()
})
export type ExtractedPage = z.infer<typeof ExtractedPageSchema>

/** Upper bound on stored body text, in characters. */
export const MAX_INDEXED_BODY_CHARS = 120_000
