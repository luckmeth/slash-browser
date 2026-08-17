import { describe, it, expect } from 'vitest'
import { buildSuggestions, type SuggestionSources } from './SuggestionEngine'
import type { HistoryEntry, Bookmark } from '@shared/types/browsing'
import type { Tab } from '@shared/types/tab'

function history(url: string, title: string, visitCount = 1): HistoryEntry {
  return { id: url.length, url, title, faviconUrl: null, visitCount, lastVisitedAt: 0 }
}

function bookmark(url: string, title: string): Bookmark {
  return {
    id: url.length,
    url,
    title,
    faviconUrl: null,
    parentId: null,
    isFolder: false,
    sortOrder: 0,
    createdAt: 0
  }
}

function tab(url: string, title: string): Tab {
  return {
    id: `tab-${title}`,
    workspaceId: 'default',
    url,
    title,
    faviconUrl: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isPinned: false,
    isAudible: false,
    isMuted: false,
    isProtected: false,
    isFrozen: false,
    zoomLevel: 0,
    findResult: null,
    status: 'live',
    error: null,
    lastActiveAt: 0,
    createdAt: 0
  }
}

function sources(overrides: Partial<SuggestionSources> = {}): SuggestionSources {
  return { history: [], bookmarks: [], openTabs: [], engineId: 'duckduckgo', ...overrides }
}

describe('buildSuggestions', () => {
  it('returns nothing for empty input', () => {
    expect(buildSuggestions('', sources())).toEqual([])
    expect(buildSuggestions('   ', sources())).toEqual([])
  })

  it('puts the literal reading of the input first', () => {
    // Pressing Enter immediately must do what the field says, never jump to a
    // history hit the user did not look at.
    const [first] = buildSuggestions('example.com', sources({ history: [history('https://other.com', 'Other')] }))
    expect(first?.kind).toBe('navigate')
    expect(first?.url).toBe('https://example.com')

    const [firstSearch] = buildSuggestions('how to center a div', sources())
    expect(firstSearch?.kind).toBe('search')
    expect(firstSearch?.title).toBe('how to center a div')
  })

  it('ranks an already-open tab above bookmarks and history', () => {
    const result = buildSuggestions(
      'wiki',
      sources({
        openTabs: [tab('https://wikipedia.org', 'Wikipedia')],
        bookmarks: [bookmark('https://wiki.example.com', 'Wiki mirror')],
        history: [history('https://wiki.other.com', 'Wiki other')]
      })
    )
    const kinds = result.map((s) => s.kind)
    expect(kinds.indexOf('open-tab')).toBeLessThan(kinds.indexOf('bookmark'))
    expect(kinds.indexOf('bookmark')).toBeLessThan(kinds.indexOf('history'))
  })

  it('never offers the same page twice across sources', () => {
    const result = buildSuggestions(
      'example',
      sources({
        openTabs: [tab('https://example.com/docs', 'Docs')],
        bookmarks: [bookmark('https://example.com/docs/', 'Docs bookmark')],
        history: [history('https://example.com/docs#intro', 'Docs history')]
      })
    )
    const pageRows = result.filter((s) => s.kind !== 'search' && s.kind !== 'navigate')
    expect(pageRows).toHaveLength(1)
    expect(pageRows[0]?.kind).toBe('open-tab')
  })

  it('offers a search fallback after a typed URL, since domains get mistyped', () => {
    const result = buildSuggestions('exampl.com', sources())
    expect(result[0]?.kind).toBe('navigate')
    expect(result.some((s) => s.kind === 'search')).toBe(true)
  })

  it('matches on title as well as url', () => {
    const result = buildSuggestions(
      'hacker',
      sources({ history: [history('https://news.ycombinator.com', 'Hacker News')] })
    )
    expect(result.some((s) => s.title === 'Hacker News')).toBe(true)
  })

  it('caps the list', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      history(`https://site${i}.com`, `Site ${i}`)
    )
    expect(buildSuggestions('site', sources({ history: many }))).toHaveLength(8)
  })

  it('honours the configured search engine', () => {
    const [first] = buildSuggestions('typescript', sources({ engineId: 'google' }))
    expect(first?.url).toBe('https://www.google.com/search?q=typescript')
    expect(first?.subtitle).toContain('Google')
  })

  describe('browsing memory rows', () => {
    const memory = (url: string, title: string, reason = 'matched indexes') => ({
      pageId: url.length,
      url,
      title,
      siteName: null,
      snippet: '',
      visitedAt: 0,
      score: 1,
      reasons: [{ kind: 'keyword' as const, detail: reason }]
    })

    it('offers a page matched on its contents', () => {
      // The words are nowhere in the title or the address — this row can only
      // have come from what was on the page, which is the entire point.
      const result = buildSuggestions(
        'database speed',
        sources({ memory: [memory('https://example.com/a', 'Indexing explained')] })
      )
      const hit = result.find((s) => s.kind === 'memory')
      expect(hit?.title).toBe('Indexing explained')
    })

    it('says why it matched', () => {
      const result = buildSuggestions(
        'database speed',
        sources({ memory: [memory('https://example.com/a', 'Indexing', 'similar in meaning')] })
      )
      // Without the reason, a page the user does not recognise is
      // indistinguishable from a bad guess.
      expect(result.find((s) => s.kind === 'memory')?.subtitle).toBe(
        'example.com · similar in meaning'
      )
    })

    it('never crowds out the literal reading of the input', () => {
      const many = Array.from({ length: 20 }, (_, i) =>
        memory(`https://example.com/${i}`, `Page ${i}`)
      )
      const result = buildSuggestions('database speed', sources({ memory: many }))
      expect(result[0]?.kind).toBe('search')
      expect(result.filter((s) => s.kind === 'memory')).toHaveLength(3)
    })

    it('does not repeat a page already offered as an open tab', () => {
      const result = buildSuggestions(
        'database',
        sources({
          openTabs: [tab('https://example.com/a', 'Database')],
          memory: [memory('https://example.com/a', 'Database')]
        })
      )
      expect(result.filter((s) => s.url === 'https://example.com/a')).toHaveLength(1)
    })

    it('changes nothing when memory is off', () => {
      // The default install passes no memory at all; the omnibox must behave
      // exactly as it did before the feature existed.
      const without = buildSuggestions('database speed', sources())
      const empty = buildSuggestions('database speed', sources({ memory: [] }))
      expect(without).toEqual(empty)
      expect(without.some((s) => s.kind === 'memory')).toBe(false)
    })
  })
})
