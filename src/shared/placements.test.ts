import { describe, it, expect } from 'vitest'
import { placementShapeFor } from './placements'
import { PLACEMENTS } from './types/sponsor'

/**
 * These assertions are the contract between two codebases.
 *
 * `placementShapeFor` is a deliberate copy of `placementFor` in
 * `platform/shared/src/batch.ts`, because the browser must be able to read a
 * batch without building the platform. A copy that drifts is worse than an
 * import that could not exist, so the table lives here in a test rather than in
 * somebody's memory: if the server ever maps a tier differently, this file is
 * what has to change with it.
 */
describe('placementShapeFor', () => {
  it.each([
    ['newtab_background', 'background'],
    ['newtab_banner', 'banner'],
    ['browser_notice', 'notice'],
    ['newtab_feature', 'tile'],
    ['home_banner', 'tile']
  ])('maps %s to %s', (tier, shape) => {
    expect(placementShapeFor(tier)).toBe(shape)
  })

  it('falls back to a tile for a tier it does not know', () => {
    // Matching the server exactly. A creative the browser cannot place is
    // better drawn as a tile than dropped — the advertiser has already paid
    // for it.
    expect(placementShapeFor('something_new')).toBe('tile')
    expect(placementShapeFor('')).toBe('tile')
  })

  it('only ever returns a shape the browser can actually draw', () => {
    for (const tier of ['newtab_background', 'newtab_banner', 'browser_notice', 'x']) {
      expect(PLACEMENTS).toContain(placementShapeFor(tier))
    }
  })
})
