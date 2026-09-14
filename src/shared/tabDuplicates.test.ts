import { describe, it, expect } from 'vitest'
import {
  normaliseForDuplicates,
  findDuplicateGroups,
  duplicateCloseIds,
  VISIT_PARAMETERS,
  type DuplicateCandidate
} from './tabDuplicates'

const NOW = 1_700_000_000_000

let nextId = 0
const tab = (over: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  id: `t${(nextId += 1)}`,
  url: 'https://example.com/',
  title: 'Example Domain',
  lastActiveAt: NOW,
  ...over
})

describe('normaliseForDuplicates', () => {
  it('drops the fragment, which is a place on one page', () => {
    expect(normaliseForDuplicates('https://example.com/docs#install')).toBe('example.com/docs')
  })

  it('drops a trailing slash', () => {
    expect(normaliseForDuplicates('https://example.com/docs/')).toBe('example.com/docs')
  })

  it('treats http and https as the same page', () => {
    // A site that upgrades you is not a different site.
    expect(normaliseForDuplicates('http://example.com/a')).toBe(
      normaliseForDuplicates('https://example.com/a')
    )
  })

  it('drops www', () => {
    expect(normaliseForDuplicates('https://www.example.com/a')).toBe('example.com/a')
  })

  it('lowercases the host but not the path', () => {
    // Hosts are case-insensitive; paths are case-sensitive on most servers, and
    // folding them would merge two genuinely different pages.
    expect(normaliseForDuplicates('https://EXAMPLE.com/Docs')).toBe('example.com/Docs')
  })

  it.each(VISIT_PARAMETERS)('drops %s, which identifies a visit', (name) => {
    expect(normaliseForDuplicates(`https://example.com/a?${name}=x`)).toBe('example.com/a')
  })

  it('keeps parameters that identify the page', () => {
    // The failure this guards against is showing somebody two different
    // products as one page, which is worse than missing a duplicate.
    expect(normaliseForDuplicates('https://shop.example/p?id=42')).toBe('shop.example/p?id=42')
    expect(normaliseForDuplicates('https://example.com/s?q=cats')).toBe('example.com/s?q=cats')
  })

  it('keeps a page parameter beside a dropped tracking one', () => {
    expect(normaliseForDuplicates('https://shop.example/p?id=42&utm_source=mail')).toBe(
      'shop.example/p?id=42'
    )
  })

  it('sorts parameters, so order is not a difference', () => {
    expect(normaliseForDuplicates('https://e.com/a?b=2&a=1')).toBe(
      normaliseForDuplicates('https://e.com/a?a=1&b=2')
    )
  })

  it('does not strip index.html', () => {
    // Plenty of sites serve something different there, and guessing costs more
    // than the duplicate it would catch.
    expect(normaliseForDuplicates('https://e.com/index.html')).toBe('e.com/index.html')
  })

  it('leaves a non-web address alone', () => {
    expect(normaliseForDuplicates('slash://newtab')).toBe('slash://newtab')
  })

  it('does not throw on something that is not a URL', () => {
    expect(normaliseForDuplicates('not a url')).toBe('not a url')
  })
})

describe('findDuplicateGroups', () => {
  it('finds nothing in a list of different pages', () => {
    const groups = findDuplicateGroups([
      tab({ url: 'https://a.example/' }),
      tab({ url: 'https://b.example/' })
    ])
    expect(groups).toEqual([])
  })

  it('finds nothing in a single tab', () => {
    expect(findDuplicateGroups([tab()])).toEqual([])
  })

  it('reports an identical address as the strongest reason', () => {
    const groups = findDuplicateGroups([
      tab({ id: 'a', url: 'https://x.example/p' }),
      tab({ id: 'b', url: 'https://x.example/p' })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.reason).toBe('same-address')
  })

  it('finds the same page reached different ways', () => {
    const groups = findDuplicateGroups([
      tab({ id: 'a', url: 'https://www.x.example/p/', title: 'One' }),
      tab({ id: 'b', url: 'http://x.example/p?utm_source=mail', title: 'Two' })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.reason).toBe('same-page')
  })

  it('keeps the most recently used copy', () => {
    const groups = findDuplicateGroups([
      tab({ id: 'old', url: 'https://x.example/p', lastActiveAt: NOW - 10_000 }),
      tab({ id: 'new', url: 'https://x.example/p', lastActiveAt: NOW })
    ])
    expect(groups[0]?.keepId).toBe('new')
    expect(groups[0]?.closeIds).toEqual(['old'])
  })

  it('keeps a pinned copy even when another was used more recently', () => {
    // Pinning is somebody saying "this one stays". Closing it to tidy up would
    // undo a deliberate choice.
    const groups = findDuplicateGroups([
      tab({ id: 'pinned', url: 'https://x.example/p', lastActiveAt: NOW - 10_000, isPinned: true }),
      tab({ id: 'recent', url: 'https://x.example/p', lastActiveAt: NOW })
    ])
    expect(groups[0]?.keepId).toBe('pinned')
    expect(groups[0]?.closeIds).toEqual(['recent'])
  })

  it('never offers to close a pinned or protected tab', () => {
    const groups = findDuplicateGroups([
      tab({ id: 'plain', url: 'https://x.example/p', lastActiveAt: NOW }),
      tab({ id: 'pin', url: 'https://x.example/p', lastActiveAt: NOW - 1, isPinned: true }),
      tab({ id: 'prot', url: 'https://x.example/p', lastActiveAt: NOW - 2, isProtected: true })
    ])
    // The pinned copy is the one that survives, and the protected one is left
    // where it is — so the only tab on offer is the plain third copy.
    expect(groups[0]?.keepId).toBe('pin')
    expect(groups[0]?.closeIds).toEqual(['plain'])
  })

  it('reports no group when every extra copy is one it must not touch', () => {
    // Otherwise the panel shows "2 duplicate tabs" beside a button that would
    // close none of them.
    const groups = findDuplicateGroups([
      tab({ id: 'pin', url: 'https://x.example/p', lastActiveAt: NOW, isPinned: true }),
      tab({ id: 'prot', url: 'https://x.example/p', lastActiveAt: NOW - 1, isProtected: true })
    ])
    expect(groups).toEqual([])
  })

  it('groups three copies into one suggestion', () => {
    const groups = findDuplicateGroups([
      tab({ id: 'a', url: 'https://x.example/p', lastActiveAt: NOW }),
      tab({ id: 'b', url: 'https://x.example/p', lastActiveAt: NOW - 1 }),
      tab({ id: 'c', url: 'https://x.example/p', lastActiveAt: NOW - 2 })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.closeIds).toEqual(['b', 'c'])
  })

  it('matches a shared title on one host', () => {
    const groups = findDuplicateGroups([
      tab({ id: 'a', url: 'https://docs.example/v1/guide', title: 'Getting started guide' }),
      tab({ id: 'b', url: 'https://docs.example/v2/guide', title: 'Getting started guide' })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.reason).toBe('same-title')
  })

  it('never matches a title across different hosts', () => {
    // "Home" and "Dashboard" are the same title on half the web. Offering to
    // close a bank tab because it shares a title with an email tab is exactly
    // the failure this must not produce.
    const groups = findDuplicateGroups([
      tab({ id: 'a', url: 'https://bank.example/', title: 'Dashboard — overview' }),
      tab({ id: 'b', url: 'https://mail.example/', title: 'Dashboard — overview' })
    ])
    expect(groups).toEqual([])
  })

  it('ignores a very short title', () => {
    const groups = findDuplicateGroups([
      tab({ id: 'a', url: 'https://x.example/1', title: 'Home' }),
      tab({ id: 'b', url: 'https://x.example/2', title: 'Home' })
    ])
    expect(groups).toEqual([])
  })

  it('puts a tab in at most one group, under its strongest reason', () => {
    const groups = findDuplicateGroups([
      tab({ id: 'a', url: 'https://x.example/p', title: 'Long enough title' }),
      tab({ id: 'b', url: 'https://x.example/p', title: 'Long enough title' }),
      tab({ id: 'c', url: 'https://x.example/other', title: 'Long enough title' })
    ])
    const ids = groups.flatMap((g) => g.tabs.map((t) => t.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(groups[0]?.reason).toBe('same-address')
  })

  it('lists tabs most recently used first', () => {
    const groups = findDuplicateGroups([
      tab({ id: 'old', url: 'https://x.example/p', lastActiveAt: NOW - 5000 }),
      tab({ id: 'new', url: 'https://x.example/p', lastActiveAt: NOW })
    ])
    expect(groups[0]?.tabs.map((t) => t.id)).toEqual(['new', 'old'])
  })
})

describe('duplicateCloseIds', () => {
  it('is everything every group would close, and nothing it would keep', () => {
    const tabs = [
      tab({ id: 'a1', url: 'https://a.example/p', lastActiveAt: NOW }),
      tab({ id: 'a2', url: 'https://a.example/p', lastActiveAt: NOW - 1 }),
      tab({ id: 'b1', url: 'https://b.example/p', lastActiveAt: NOW }),
      tab({ id: 'b2', url: 'https://b.example/p', lastActiveAt: NOW - 1 })
    ]
    const ids = duplicateCloseIds(findDuplicateGroups(tabs))
    expect(new Set(ids)).toEqual(new Set(['a2', 'b2']))
  })

  it('is empty when there is nothing to close', () => {
    expect(duplicateCloseIds([])).toEqual([])
  })
})
