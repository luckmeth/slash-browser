import { describe, it, expect } from 'vitest'
import { distanceToSimilarity, reciprocalRankFusion, type FusionInput } from './fusion'

const fuse = (keyword: number[], semantic: number[]) =>
  reciprocalRankFusion<number>(
    new Map<string, FusionInput<number>>([
      ['keyword', { ranking: keyword }],
      ['semantic', { ranking: semantic }]
    ])
  )

describe('reciprocalRankFusion', () => {
  it('ranks agreement above either list’s own favourite', () => {
    // 2 is second in both; 1 and 3 each lead one list and are absent from the
    // other. Agreement is the signal RRF exists to reward.
    const [top] = fuse([1, 2, 9], [3, 2, 8])
    expect(top!.key).toBe(2)
  })

  it('preserves order when only one list has anything to say', () => {
    expect(fuse([5, 6, 7], []).map((entry) => entry.key)).toEqual([5, 6, 7])
    expect(fuse([], [5, 6, 7]).map((entry) => entry.key)).toEqual([5, 6, 7])
  })

  it('returns nothing for two empty lists', () => {
    expect(fuse([], [])).toEqual([])
  })

  it('records where each key came from', () => {
    const fused = fuse([1, 2], [2])
    const two = fused.find((entry) => entry.key === 2)!
    expect(two.ranks.get('keyword')).toBe(1)
    expect(two.ranks.get('semantic')).toBe(0)

    const one = fused.find((entry) => entry.key === 1)!
    expect(one.ranks.has('semantic')).toBe(false)
  })

  it('counts only the best position when a key repeats in one list', () => {
    // Several chunks of one page land in the same ranking. Being verbose must
    // not be worth more than being relevant.
    const verbose = reciprocalRankFusion<number>(
      new Map([['semantic', { ranking: [1, 1, 1, 1, 2] }]])
    )
    expect(verbose[0]!.key).toBe(1)
    expect(verbose[0]!.ranks.get('semantic')).toBe(0)
    // 1 appeared four times but is scored once at its best rank, so its lead
    // over 2 is a single position rather than four contributions.
    expect(verbose[0]!.score).toBeLessThan(4 / 61)
  })

  it('lets a weight shift the balance without changing the shape', () => {
    const weighted = reciprocalRankFusion<number>(
      new Map([
        ['keyword', { ranking: [1, 2], weight: 1 }],
        ['semantic', { ranking: [2, 1], weight: 5 }]
      ])
    )
    expect(weighted[0]!.key).toBe(2)
  })

  it('breaks ties on the best single rank', () => {
    // Symmetrical scores: 1 leads the keyword list, 2 leads the semantic one.
    const fused = fuse([1, 2], [2, 1])
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score)
    expect(fused).toHaveLength(2)
  })
})

describe('distanceToSimilarity', () => {
  it('maps cosine distance to a percentage a person can read', () => {
    expect(distanceToSimilarity(0)).toBe(1)
    expect(distanceToSimilarity(1)).toBe(0)
    expect(distanceToSimilarity(0.25)).toBeCloseTo(0.75)
  })

  it('clamps the floating-point noise around identical vectors', () => {
    // sqlite-vec returns a hair below zero for near-identical normalised
    // vectors; "-0.4% similar" in the interface would be nonsense.
    expect(distanceToSimilarity(-0.000001)).toBe(1)
    expect(distanceToSimilarity(2.5)).toBe(0)
    expect(distanceToSimilarity(Number.NaN)).toBe(0)
  })
})
