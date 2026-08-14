import { MAX_SUGGESTIONS, type Suggestion } from '@shared/types/omnibox'
import { SEARCH_ENGINES, type SearchEngineId } from '@shared/constants'
import { hostOf } from '@shared/url'
import type { HistoryEntry, Bookmark } from '@shared/types/browsing'
import type { Tab } from '@shared/types/tab'
import { resolveInput } from './UrlResolver'

export interface SuggestionSources {
  history: HistoryEntry[]
  bookmarks: Bookmark[]
  openTabs: Tab[]
  engineId: SearchEngineId
}

/**
 * Ranks omnibox suggestions.
 *
 * Pure, so the ordering rules are testable without a database or an Electron
 * window. Ordering is the whole feature — a list containing the right answer in
 * seventh place is no better than not having one.
 */
export function buildSuggestions(rawQuery: string, sources: SuggestionSources): Suggestion[] {
  const query = rawQuery.trim()
  if (query === '') return []

  const lower = query.toLowerCase()
  const resolved = resolveInput(query, sources.engineId)
  const engine = SEARCH_ENGINES[sources.engineId] ?? SEARCH_ENGINES.duckduckgo
  const suggestions: Suggestion[] = []

  // 1. The literal interpretation of what was typed, first — pressing Enter
  //    immediately must always do what the top row says it will.
  if (resolved.kind === 'url') {
    suggestions.push({
      id: 'top:navigate',
      kind: 'navigate',
      title: resolved.url,
      subtitle: 'Open this address',
      url: resolved.url,
      tabId: null,
      faviconUrl: null
    })
  } else if (resolved.kind === 'search') {
    suggestions.push({
      id: 'top:search',
      kind: 'search',
      title: query,
      subtitle: `Search with ${engine.name}`,
      url: resolved.url,
      tabId: null,
      faviconUrl: null
    })
  }

  // 2. Already-open tabs. Switching beats opening a second copy, so these rank
  //    above history and bookmarks for the same URL.
  const seen = new Set<string>()
  for (const tab of sources.openTabs) {
    if (suggestions.length >= MAX_SUGGESTIONS) break
    const haystack = `${tab.title} ${tab.url}`.toLowerCase()
    if (!haystack.includes(lower)) continue
    const key = normalise(tab.url)
    if (seen.has(key)) continue
    seen.add(key)
    suggestions.push({
      id: `tab:${tab.id}`,
      kind: 'open-tab',
      title: tab.title || hostOf(tab.url),
      subtitle: 'Switch to this tab',
      url: tab.url,
      tabId: tab.id,
      faviconUrl: tab.faviconUrl
    })
  }

  // 3. Bookmarks — deliberately saved, so they outrank incidental history.
  for (const bookmark of sources.bookmarks) {
    if (suggestions.length >= MAX_SUGGESTIONS) break
    if (bookmark.isFolder) continue
    const haystack = `${bookmark.title} ${bookmark.url}`.toLowerCase()
    if (!haystack.includes(lower)) continue
    const key = normalise(bookmark.url)
    if (seen.has(key)) continue
    seen.add(key)
    suggestions.push({
      id: `bookmark:${bookmark.id}`,
      kind: 'bookmark',
      title: bookmark.title,
      subtitle: hostOf(bookmark.url),
      url: bookmark.url,
      tabId: null,
      faviconUrl: bookmark.faviconUrl
    })
  }

  // 4. History, already ordered by visit count then recency upstream.
  for (const entry of sources.history) {
    if (suggestions.length >= MAX_SUGGESTIONS) break
    const key = normalise(entry.url)
    if (seen.has(key)) continue
    seen.add(key)
    suggestions.push({
      id: `history:${entry.id}`,
      kind: 'history',
      title: entry.title || hostOf(entry.url),
      subtitle: hostOf(entry.url),
      url: entry.url,
      tabId: null,
      faviconUrl: entry.faviconUrl
    })
  }

  // A typed URL should still offer a search as a fallback, since a mistyped
  // domain is common and the search is often what was meant.
  if (resolved.kind === 'url' && suggestions.length < MAX_SUGGESTIONS) {
    suggestions.push({
      id: 'fallback:search',
      kind: 'search',
      title: query,
      subtitle: `Search with ${engine.name}`,
      url: SEARCH_ENGINES[sources.engineId].url.replace('%s', encodeURIComponent(query)),
      tabId: null,
      faviconUrl: null
    })
  }

  return suggestions.slice(0, MAX_SUGGESTIONS)
}

function normalise(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    const text = parsed.toString()
    return text.endsWith('/') ? text.slice(0, -1) : text
  } catch {
    return url
  }
}
