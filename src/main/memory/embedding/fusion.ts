/**
 * Combining two rankings that do not share a scale.
 *
 * BM25 scores and cosine distances are not comparable — not after normalising,
 * not after weighting. A page scoring 8.2 on BM25 and one at distance 0.31 have
 * no common unit, and any arithmetic that mixes them is inventing one.
 *
 * Reciprocal rank fusion sidesteps that by throwing the scores away and using
 * only the *positions*: a page's contribution from a list is `1 / (k + rank)`.
 * It needs no tuning per corpus, it degrades gracefully when one list is empty,
 * and — the property that matters most here — a page both searches agree on
 * outranks a page either one loved alone.
 */

/** The standard damping constant from the original RRF paper (Cormack, 2009). */
const RRF_K = 60

export interface FusionInput<T> {
  /** Ranked best-first. Position in the array *is* the rank. */
  readonly ranking: readonly T[]
  /**
   * Relative say this list gets. Both default to 1: neither keyword nor meaning
   * is generally the better answer, and pretending otherwise is a guess.
   */
  readonly weight?: number
}

export interface FusedEntry<K> {
  readonly key: K
  readonly score: number
  /** Zero-based position in each contributing list, absent where it did not appear. */
  readonly ranks: ReadonlyMap<string, number>
}

/**
 * Fuses any number of named rankings over a shared key.
 *
 * Returns every key that appeared in at least one list, best first. Ties break
 * on the best single rank achieved, so a first place somewhere always beats a
 * pair of distant mentions with the same arithmetic total.
 */
export function reciprocalRankFusion<K>(
  lists: ReadonlyMap<string, FusionInput<K>>
): FusedEntry<K>[] {
  const scores = new Map<K, { score: number; ranks: Map<string, number> }>()

  for (const [name, list] of lists) {
    const weight = list.weight ?? 1
    list.ranking.forEach((key, index) => {
      let entry = scores.get(key)
      if (!entry) {
        entry = { score: 0, ranks: new Map() }
        scores.set(key, entry)
      }
      entry.score += weight / (RRF_K + index + 1)
      // A key can legitimately appear twice in one list — several chunks of the
      // same page, for instance. Only its best position counts, or a page would
      // be able to outrank a better one by being verbose.
      const existing = entry.ranks.get(name)
      if (existing === undefined || index < existing) entry.ranks.set(name, index)
    })
  }

  return [...scores.entries()]
    .map(([key, entry]) => ({ key, score: entry.score, ranks: entry.ranks }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return bestRank(a.ranks) - bestRank(b.ranks)
    })
}

function bestRank(ranks: ReadonlyMap<string, number>): number {
  let best = Number.MAX_SAFE_INTEGER
  for (const rank of ranks.values()) if (rank < best) best = rank
  return best
}

/**
 * Cosine *distance* from sqlite-vec turned into a similarity a person can read.
 *
 * vec0 reports distance where 0 is identical. For normalised vectors that is
 * `1 - cosine`, so similarity is `1 - distance`, clamped because floating-point
 * error puts near-identical vectors a hair below zero and "-0.4% similar" in the
 * interface would be nonsense.
 */
export function distanceToSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0
  return Math.min(1, Math.max(0, 1 - distance))
}
