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
})
