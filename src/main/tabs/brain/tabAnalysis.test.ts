import { describe, it, expect } from 'vitest'
import type { Tab } from '@shared/types/tab'
import {
  analyseTabs,
  canonicalUrl,
  clusterTabs,
  findDuplicates,
  nameCluster,
  similarity,
  suggestClosures,
  tokenize
} from './tabAnalysis'

const NOW = new Date('2026-08-17T12:00:00Z').getTime()
const HOUR = 3_600_000

function tab(over: Partial<Tab> & { id: string; url: string }): Tab {
  return {
    workspaceId: 'default',
    title: '',
    faviconUrl: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isPinned: false,
    groupId: null,
    isAudible: false,
    isMuted: false,
    isProtected: false,
    isFrozen: false,
    zoomLevel: 0,
    findResult: null,
    status: 'live',
    error: null,
    lastActiveAt: NOW,
    createdAt: NOW,
    ...over
  }
}

describe('canonicalUrl', () => {
  it('ignores tracking parameters and fragments', () => {
    // Two campaign links to one article are one page.
    expect(canonicalUrl('https://example.com/post?utm_source=twitter&fbclid=x#intro')).toBe(
      'https://example.com/post'
    )
  })

  it('ignores www and a trailing slash', () => {
    expect(canonicalUrl('https://www.example.com/a/')).toBe(canonicalUrl('https://example.com/a'))
  })

  it('keeps parameters that identify the page', () => {
    // ?id=42 is the page; dropping it would merge unrelated tabs.
    expect(canonicalUrl('https://example.com/item?id=42')).toContain('id=42')
  })

  it('is order-insensitive about query parameters', () => {
    expect(canonicalUrl('https://example.com/x?b=2&a=1')).toBe(
      canonicalUrl('https://example.com/x?a=1&b=2')
    )
  })

  it('returns a malformed URL unchanged rather than throwing', () => {
    expect(canonicalUrl('not a url')).toBe('not a url')
  })
})

describe('tokenize', () => {
  it('drops words that indicate nothing', () => {
    const tokens = tokenize({ title: 'The Best Free Download Site', url: 'https://example.com/' })
    // Without this every cluster would be joined by "the" and "download".
    expect(tokens.has('the')).toBe(false)
    expect(tokens.has('download')).toBe(false)
    expect(tokens.has('best')).toBe(false)
  })

  it('reads the URL path as well as the title', () => {
    // Pages with opaque titles still cluster by where they live.
    const tokens = tokenize({ title: '', url: 'https://gov.uk/visa/appointment' })
    expect(tokens.has('visa')).toBe(true)
    expect(tokens.has('appointment')).toBe(true)
  })

  it('includes the site name so same-site tabs relate', () => {
    expect(tokenize({ title: '', url: 'https://kyoto-u.ac.jp/x' }).has('ac')).toBe(false)
    expect(tokenize({ title: '', url: 'https://wikipedia.org/x' }).has('wikipedia')).toBe(true)
  })

  it('drops bare numbers and very short words', () => {
    const tokens = tokenize({ title: 'Room 12 of 4', url: 'https://example.com/a' })
    expect(tokens.has('12')).toBe(false)
    expect(tokens.has('of')).toBe(false)
    expect(tokens.has('room')).toBe(true)
  })
})

describe('similarity', () => {
  it('is 1 for identical sets and 0 for disjoint ones', () => {
    expect(similarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
    expect(similarity(new Set(['a']), new Set(['b']))).toBe(0)
  })

  it('normalises for length', () => {
    // Three shared words out of four is a stronger signal than three out of forty.
    const small = similarity(new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b', 'c', 'e']))
    const large = similarity(
      new Set(['a', 'b', 'c', ...Array.from({ length: 37 }, (_, i) => `x${i}`)]),
      new Set(['a', 'b', 'c', 'e'])
    )
    expect(small).toBeGreaterThan(large)
  })

  it('is 0 when either side is empty', () => {
    expect(similarity(new Set(), new Set(['a']))).toBe(0)
  })
})

describe('findDuplicates', () => {
  it('groups the same page opened twice', () => {
    const sets = findDuplicates([
      tab({ id: '1', url: 'https://example.com/a', title: 'A' }),
      tab({ id: '2', url: 'https://example.com/a', title: 'A' }),
      tab({ id: '3', url: 'https://example.com/b' })
    ])
    expect(sets).toHaveLength(1)
    expect(sets[0]!.tabIds).toEqual(['1', '2'])
    expect(sets[0]!.exact).toBe(true)
  })

  it('marks a match that needed normalising as inexact', () => {
    // Same article, different campaign link — the user may still want both.
    const sets = findDuplicates([
      tab({ id: '1', url: 'https://example.com/a' }),
      tab({ id: '2', url: 'https://example.com/a?utm_source=x' })
    ])
    expect(sets[0]!.exact).toBe(false)
  })

  it('ignores internal pages', () => {
    // Three new-tab pages are not three duplicates to clean up.
    expect(
      findDuplicates([
        tab({ id: '1', url: 'slash://newtab' }),
        tab({ id: '2', url: 'slash://newtab' })
      ])
    ).toEqual([])
  })

  it('puts the biggest pile-up first', () => {
    const sets = findDuplicates([
      tab({ id: '1', url: 'https://a.com/x' }),
      tab({ id: '2', url: 'https://a.com/x' }),
      tab({ id: '3', url: 'https://b.com/y' }),
      tab({ id: '4', url: 'https://b.com/y' }),
      tab({ id: '5', url: 'https://b.com/y' })
    ])
    expect(sets[0]!.tabIds).toHaveLength(3)
  })
})

describe('clusterTabs', () => {
  const japanTabs = [
    tab({
      id: '1',
      url: 'https://kyoto-u.ac.jp/admissions/graduate',
      title: 'Kyoto University Graduate School Admissions'
    }),
    tab({
      id: '2',
      url: 'https://waseda.jp/admissions/graduate',
      title: 'Waseda University Graduate Admissions'
    }),
    tab({
      id: '3',
      url: 'https://u-tokyo.ac.jp/admissions/graduate',
      title: 'University of Tokyo Graduate Admissions'
    }),
    tab({ id: '4', url: 'https://gov.uk/japan-student-visa', title: 'Japan Student Visa' }),
    tab({ id: '5', url: 'https://news.example.com/football', title: 'Football results' })
  ]

  it('groups tabs that belong to one piece of work', () => {
    const groups = clusterTabs(japanTabs)
    expect(groups.length).toBeGreaterThanOrEqual(1)
    const biggest = groups[0]!
    expect(biggest.tabIds).toEqual(expect.arrayContaining(['1', '2', '3']))
    // The unrelated tab must not be swept in.
    expect(biggest.tabIds).not.toContain('5')
  })

  it('names a group from terms its tabs share', () => {
    const groups = clusterTabs(japanTabs)
    expect(groups[0]!.name.toLowerCase()).toMatch(/university|admissions|graduate/)
  })

  it('explains why a group exists', () => {
    // A grouping the user cannot understand is one they cannot correct.
    expect(clusterTabs(japanTabs)[0]!.reason).toMatch(/tabs/)
  })

  it('does not join tabs that are related in meaning but share no words', () => {
    // A known and accepted limit of lexical clustering: a human knows the visa
    // tab belongs to the same application as the three universities, but it
    // shares no distinctive term with them, so it stays ungrouped. Recorded as a
    // test rather than left as folklore — the alternative is lowering the
    // threshold until unrelated tabs start merging, which is worse.
    const groups = clusterTabs(japanTabs)
    expect(groups[0]!.tabIds).not.toContain('4')
  })

  it('leaves pinned tabs alone', () => {
    // A pinned tab is already organised by hand.
    const withPinned = japanTabs.map((t) => (t.id === '1' ? { ...t, isPinned: true } : t))
    const groups = clusterTabs(withPinned)
    expect(groups.flatMap((g) => g.tabIds)).not.toContain('1')
  })

  it('does not report a group of two', () => {
    const groups = clusterTabs([
      tab({ id: '1', url: 'https://example.com/visa-japan', title: 'Japan visa' }),
      tab({ id: '2', url: 'https://example.com/visa-japan-2', title: 'Japan visa two' })
    ])
    expect(groups).toEqual([])
  })

  it('groups nothing when tabs are unrelated', () => {
    const groups = clusterTabs([
      tab({ id: '1', url: 'https://cooking.example/pasta', title: 'Pasta recipe' }),
      tab({ id: '2', url: 'https://bank.example/statement', title: 'Bank statement' }),
      tab({ id: '3', url: 'https://weather.example/forecast', title: 'Weather forecast' })
    ])
    expect(groups).toEqual([])
  })

  it('handles an empty set', () => {
    expect(clusterTabs([])).toEqual([])
  })

  it('does not fuse everything because all tabs come from one site', () => {
    // Found by a live probe: an article about sourdough joined a cluster about
    // databases purely because every tab was titled "… - Wikipedia". A token
    // carried by every tab raises every pair's score identically, so it can only
    // merge, never distinguish.
    const wikipedia = [
      tab({ id: '1', url: 'https://en.wikipedia.org/wiki/Database_index', title: 'Database index - Wikipedia' }),
      tab({ id: '2', url: 'https://en.wikipedia.org/wiki/Database_normalization', title: 'Database normalization - Wikipedia' }),
      tab({ id: '3', url: 'https://en.wikipedia.org/wiki/Database_transaction', title: 'Database transaction - Wikipedia' }),
      tab({ id: '4', url: 'https://en.wikipedia.org/wiki/Sourdough', title: 'Sourdough - Wikipedia' }),
      tab({ id: '5', url: 'https://en.wikipedia.org/wiki/Bread', title: 'Bread - Wikipedia' })
    ]
    const groups = clusterTabs(wikipedia)
    const databaseGroup = groups.find((group) => group.tabIds.includes('1'))
    expect(databaseGroup?.tabIds).toEqual(expect.arrayContaining(['1', '2', '3']))
    expect(databaseGroup?.tabIds).not.toContain('4')
    expect(databaseGroup?.tabIds).not.toContain('5')
  })
})

describe('nameCluster', () => {
  it('falls back to the host rather than inventing a topic', () => {
    const members = [
      tab({ id: '1', url: 'https://portal.example.com/x9f2', title: '' }),
      tab({ id: '2', url: 'https://portal.example.com/a71b', title: '' }),
      tab({ id: '3', url: 'https://portal.example.com/qq04', title: '' })
    ]
    const tokens = new Map(members.map((m) => [m.id, tokenize(m)]))
    const name = nameCluster(members, tokens)
    // "Tabs on portal.example.com" is at least true.
    expect(name).toMatch(/portal\.example\.com|Related tabs|Example/i)
  })
})

describe('suggestClosures', () => {
  const stale = (id: string, hours: number, over: Partial<Tab> = {}) =>
    tab({ id, url: `https://example.com/${id}`, lastActiveAt: NOW - hours * HOUR, ...over })

  it('offers long-idle tabs', () => {
    const suggestions = suggestClosures([stale('old', 100), stale('fresh', 1)], [], NOW)
    expect(suggestions.map((s) => s.tabId)).toEqual(['old'])
    expect(suggestions[0]!.reason).toContain('day')
  })

  it('never offers a pinned or protected tab', () => {
    // Both are explicit statements that the tab matters. Overriding either would
    // make the feature untrustworthy the first time it happened.
    const suggestions = suggestClosures(
      [stale('pinned', 500, { isPinned: true }), stale('protected', 500, { isProtected: true })],
      [],
      NOW
    )
    expect(suggestions).toEqual([])
  })

  it('never offers a tab that is playing audio', () => {
    // Something is playing, so it is in use whatever the timestamp says.
    expect(suggestClosures([stale('audible', 500, { isAudible: true })], [], NOW)).toEqual([])
  })

  it('keeps the most recently used copy of a duplicate', () => {
    const tabs = [
      tab({ id: 'older', url: 'https://example.com/a', lastActiveAt: NOW - 50 * HOUR }),
      tab({ id: 'newer', url: 'https://example.com/a', lastActiveAt: NOW - 1 * HOUR })
    ]
    const suggestions = suggestClosures(tabs, findDuplicates(tabs), NOW)
    expect(suggestions.map((s) => s.tabId)).toEqual(['older'])
    expect(suggestions[0]!.reason).toContain('another tab')
  })

  it('does not suggest the same tab twice', () => {
    // A duplicate that is also stale must appear once, not once per rule.
    const tabs = [
      tab({ id: 'a', url: 'https://example.com/x', lastActiveAt: NOW - 200 * HOUR }),
      tab({ id: 'b', url: 'https://example.com/x', lastActiveAt: NOW - 1 * HOUR })
    ]
    const suggestions = suggestClosures(tabs, findDuplicates(tabs), NOW)
    expect(suggestions.filter((s) => s.tabId === 'a')).toHaveLength(1)
  })

  it('ignores internal pages', () => {
    expect(suggestClosures([tab({ id: 'n', url: 'slash://newtab', lastActiveAt: 0 })], [], NOW)).toEqual([])
  })
})

describe('analyseTabs', () => {
  it('reports groups, duplicates and closures together', () => {
    const tabs = [
      tab({ id: '1', url: 'https://kyoto-u.ac.jp/admissions', title: 'Kyoto Admissions' }),
      tab({ id: '2', url: 'https://waseda.jp/admissions', title: 'Waseda Admissions' }),
      tab({ id: '3', url: 'https://example.com/japan-admissions', title: 'Japan Admissions' }),
      tab({ id: '4', url: 'https://example.com/dup' }),
      tab({ id: '5', url: 'https://example.com/dup' })
    ]
    const analysis = analyseTabs(tabs, NOW)
    expect(analysis.tabCount).toBe(5)
    expect(analysis.duplicates).toHaveLength(1)
    expect(analysis.summary).toContain('duplicate')
  })

  it('says so plainly when there is nothing to organise', () => {
    expect(analyseTabs([tab({ id: '1', url: 'slash://newtab' })], NOW).summary).toContain(
      'Open a few tabs'
    )
  })

  it('promises that nothing closes without confirmation', () => {
    const tabs = [
      tab({ id: 'old', url: 'https://example.com/a', lastActiveAt: NOW - 500 * HOUR }),
      tab({ id: 'older', url: 'https://example.com/b', lastActiveAt: NOW - 600 * HOUR })
    ]
    expect(analyseTabs(tabs, NOW).summary).toContain('without your say-so')
  })

  it('lists tabs that joined no group as ungrouped rather than hiding them', () => {
    const analysis = analyseTabs(
      [
        tab({ id: '1', url: 'https://cooking.example/pasta', title: 'Pasta' }),
        tab({ id: '2', url: 'https://bank.example/statement', title: 'Bank' })
      ],
      NOW
    )
    expect(analysis.ungroupedTabIds).toEqual(['1', '2'])
  })
})
