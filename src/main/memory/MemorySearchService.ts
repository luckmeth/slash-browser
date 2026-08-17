import type { MemoryResult, ParsedQuery } from '@shared/types/memory'
import { SEMANTIC_MIN_SIMILARITY } from '@shared/types/semantic'
import type { MemoryRepository } from '../db/repositories/MemoryRepository'
import type { SemanticIndex } from './embedding/SemanticIndex'
import { distanceToSimilarity, reciprocalRankFusion } from './embedding/fusion'

/**
 * How many nearest passages to pull before collapsing them to pages.
 *
 * Several chunks of the same long page routinely occupy consecutive
 * nearest-neighbour slots, so asking for exactly `limit` passages can come back
 * as two or three distinct pages. Over-fetching absorbs that.
 */
const CHUNK_OVERFETCH = 6

/**
 * Memory search across both indexes.
 *
 * Keyword search is the load-bearing half and runs unconditionally. The semantic
 * half is consulted only when it is genuinely ready, and its failure — model not
 * loaded, extension missing, worker crashed — is indistinguishable from it
 * simply having no opinion. There is no code path here where switching semantic
 * search on can make results worse or slower to arrive.
 */
export class MemorySearchService {
  constructor(
    private readonly memory: MemoryRepository,
    private readonly semantic: SemanticIndex
  ) {}

  async search(parsed: ParsedQuery, limit: number): Promise<MemoryResult[]> {
    // Over-fetched so fusion has something to reorder. Taking exactly `limit`
    // from each list and merging would let a page ranked 31st by keyword and
    // 1st by meaning vanish, which is the case the whole feature exists for.
    const keyword = this.memory.search(parsed, limit * 2)

    const terms = parsed.terms.trim()
    if (terms === '' || !this.semantic.isUsable()) return keyword.slice(0, limit)

    const hits = await this.semantic.search(terms, limit * CHUNK_OVERFETCH)
    if (hits.length === 0) return keyword.slice(0, limit)

    // Best passage per page. A page is one result no matter how many of its
    // paragraphs matched, and the passage shown is the closest one.
    //
    // Neighbours below the floor are dropped first: without that, every query
    // returns a full page of results whether or not anything is actually about
    // it, and "nothing matched" — which is a useful answer — becomes impossible
    // for the panel to give.
    const bestByPage = new Map<number, { text: string; distance: number }>()
    for (const hit of hits) {
      if (distanceToSimilarity(hit.distance) < SEMANTIC_MIN_SIMILARITY) continue
      const existing = bestByPage.get(hit.pageId)
      if (!existing || hit.distance < existing.distance) {
        bestByPage.set(hit.pageId, { text: hit.text, distance: hit.distance })
      }
    }
    if (bestByPage.size === 0) return keyword.slice(0, limit)

    // The vector index knows nothing about when a page was visited, so a time
    // window the user asked for has to be applied here or "last Tuesday" would
    // quietly stop meaning anything as soon as semantic search was enabled.
    const semanticPageIds = [...bestByPage.keys()]
    const pages = this.memory.pagesByIds(semanticPageIds)
    const withinWindow = semanticPageIds
      .filter((pageId) => {
        const page = pages.get(pageId)
        if (!page) return false
        if (parsed.after !== null && page.visitedAt < parsed.after) return false
        if (parsed.before !== null && page.visitedAt >= parsed.before) return false
        return true
      })
      .sort(
        (a, b) => (bestByPage.get(a)?.distance ?? 1) - (bestByPage.get(b)?.distance ?? 1)
      )

    if (withinWindow.length === 0) return keyword.slice(0, limit)

    const fused = reciprocalRankFusion<number>(
      new Map([
        ['keyword', { ranking: keyword.map((result) => result.pageId) }],
        ['semantic', { ranking: withinWindow }]
      ])
    )

    const keywordByPage = new Map(keyword.map((result) => [result.pageId, result]))

    return fused
      .slice(0, limit)
      .map((entry) => {
        const existing = keywordByPage.get(entry.key)
        const match = bestByPage.get(entry.key)
        const matchedSemantically = entry.ranks.has('semantic')

        // A page both halves found keeps its keyword snippet — highlighted terms
        // are more useful than a paragraph — and gains the semantic reason.
        if (existing) {
          return {
            ...existing,
            score: entry.score,
            reasons: matchedSemantically && match
              ? [...existing.reasons, semanticReason(match.distance)]
              : existing.reasons
          }
        }

        const page = pages.get(entry.key)
        if (!page || !match) return null

        return {
          pageId: page.pageId,
          url: page.url,
          title: page.title,
          siteName: page.siteName,
          snippet: truncate(match.text, 320),
          visitedAt: page.visitedAt,
          score: entry.score,
          reasons: [
            semanticReason(match.distance),
            ...(parsed.timeLabel
              ? [{ kind: 'recency' as const, detail: `visited ${parsed.timeLabel}` }]
              : [])
          ]
        }
      })
      .filter((result): result is MemoryResult => result !== null)
  }
}

/**
 * Why a semantic hit matched, in words rather than as a number.
 *
 * The raw cosine similarity is deliberately not shown. Its scale is nothing like
 * what a percentage implies — the best match in an index routinely scores under
 * 0.4 — so putting "39%" beside the top result tells the user their search
 * failed when it did not. The bands below are the same measurement expressed on
 * a scale a person can actually read.
 */
function semanticReason(distance: number): { kind: 'semantic'; detail: string } {
  const similarity = distanceToSimilarity(distance)
  const detail =
    similarity >= 0.55
      ? 'very close in meaning'
      : similarity >= 0.38
        ? 'close in meaning'
        : similarity >= 0.28
          ? 'related in meaning'
          : 'loosely related in meaning'
  return { kind: 'semantic', detail }
}

function truncate(value: string, limit: number): string {
  const normalised = value.replace(/\s+/g, ' ').trim()
  return normalised.length <= limit ? normalised : `${normalised.slice(0, limit - 1).trimEnd()}…`
}
