import { describe, it, expect } from 'vitest'
import { canPairWith, chooseSplitPartner, type SplitCandidate } from './splitPartner'

const page = (id: string, url = `https://example.com/${id}`): SplitCandidate => ({ id, url })
const blank = (id: string): SplitCandidate => ({ id, url: 'slash://newtab' })

describe('canPairWith', () => {
  it('accepts a real page', () => {
    expect(canPairWith(page('a'))).toBe(true)
  })

  it('refuses the new tab page', () => {
    // Not a preference. Internal pages have no page view — the chrome document
    // shows through the content hole — so there is nothing for a pane to
    // composite.
    expect(canPairWith(blank('a'))).toBe(false)
  })
})

describe('chooseSplitPartner', () => {
  it('takes the next tab when it is a real page', () => {
    const tabs = [page('a'), page('b'), page('c')]
    expect(chooseSplitPartner(tabs, 'a')?.id).toBe('b')
  })

  it('skips a blank neighbour instead of splitting with nothing', () => {
    // The bug. A fresh tab beside the page you are reading is the most likely
    // thing to be next to it, so this was the common case and it did nothing.
    const tabs = [page('a'), blank('new'), page('c')]
    expect(chooseSplitPartner(tabs, 'a')?.id).toBe('c')
  })

  it('looks backwards when everything after is blank', () => {
    const tabs = [page('a'), page('b'), blank('x'), blank('y')]
    expect(chooseSplitPartner(tabs, 'b')?.id).toBe('a')
  })

  it('searches outwards, nearest first', () => {
    const tabs = [page('far-left'), blank('l'), page('active'), blank('r'), page('right')]
    // Both real pages sit two away; the one on the right wins, which is where a
    // newly opened tab lands.
    expect(chooseSplitPartner(tabs, 'active')?.id).toBe('right')
  })

  it('prefers the right at equal distance', () => {
    const tabs = [page('left'), page('active'), page('right')]
    expect(chooseSplitPartner(tabs, 'active')?.id).toBe('right')
  })

  it('returns null when every other tab is blank', () => {
    const tabs = [blank('x'), page('active'), blank('y')]
    expect(chooseSplitPartner(tabs, 'active')).toBeNull()
  })

  it('returns null for a lone tab', () => {
    expect(chooseSplitPartner([page('only')], 'only')).toBeNull()
  })

  it('never returns the active tab, which split view refuses anyway', () => {
    const tabs = [page('a'), page('b')]
    expect(chooseSplitPartner(tabs, 'a')?.id).not.toBe('a')
    expect(chooseSplitPartner(tabs, 'b')?.id).not.toBe('b')
  })

  it('falls back to the first eligible tab when the active one is unknown', () => {
    const tabs = [blank('x'), page('b')]
    expect(chooseSplitPartner(tabs, 'gone')?.id).toBe('b')
  })

  it('handles an empty list', () => {
    expect(chooseSplitPartner([], 'a')).toBeNull()
  })
})
