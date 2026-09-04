import { describe, it, expect } from 'vitest'
import { resolveInput } from './UrlResolver'
import { formatUrlForDisplay } from '@shared/url'
import { DEFAULT_SETTINGS } from '@shared/types/settings'
import { NEW_TAB_URL } from '@shared/types/tab'
import type { SearchEngineId } from '@shared/constants'

const resolve = (input: string) => resolveInput(input, 'duckduckgo')

describe('search engine selection', () => {
  it('uses the engine it was given', () => {
    expect(resolveInput('cats', 'google').url).toBe('https://www.google.com/search?q=cats')
    expect(resolveInput('cats', 'bing').url).toBe('https://www.bing.com/search?q=cats')
  })

  it('falls back to the configured default, not to a hardcoded engine', () => {
    // The regression: an id the enum does not know — a hand-edited profile, a
    // renamed engine, a settings object that lost the key — used to resolve to
    // DuckDuckGo no matter what the user had chosen, while Settings went on
    // displaying their real preference. Silently searching somewhere the user
    // did not pick is worse than any wrong-but-visible answer.
    const unknown = 'yahoo-2003' as SearchEngineId
    expect(resolveInput('cats', unknown).url).toBe('https://www.google.com/search?q=cats')
  })

  it('ships with Google as the default', () => {
    expect(DEFAULT_SETTINGS.searchEngineId).toBe('google')
  })
})

describe('resolveInput', () => {
  it('passes through explicit http(s) URLs', () => {
    expect(resolve('https://example.com/a?b=1')).toEqual({
      kind: 'url',
      url: 'https://example.com/a?b=1'
    })
    expect(resolve('http://example.com')).toEqual({ kind: 'url', url: 'http://example.com' })
  })

  it('upgrades a bare domain to https', () => {
    expect(resolve('example.com')).toEqual({ kind: 'url', url: 'https://example.com' })
    expect(resolve('sub.example.co.uk/path')).toEqual({
      kind: 'url',
      url: 'https://sub.example.co.uk/path'
    })
  })

  it('treats prose as a search', () => {
    const result = resolve('how to center a div')
    expect(result.kind).toBe('search')
    expect(result.url).toBe('https://duckduckgo.com/?q=how%20to%20center%20a%20div')
  })

  it('treats a single word with no TLD as a search, not a hostname', () => {
    // "react" must not become https://react — a wrong search is recoverable,
    // a wrong navigation loses what was typed.
    expect(resolve('react').kind).toBe('search')
    expect(resolve('localhost-ish').kind).toBe('search')
  })

  it('handles localhost and host:port as http', () => {
    expect(resolve('localhost:3000')).toEqual({ kind: 'url', url: 'http://localhost:3000' })
    expect(resolve('localhost')).toEqual({ kind: 'url', url: 'http://localhost' })
    expect(resolve('127.0.0.1:8080/admin')).toEqual({
      kind: 'url',
      url: 'http://127.0.0.1:8080/admin'
    })
  })

  it('handles bare IPv4', () => {
    expect(resolve('192.168.1.1')).toEqual({ kind: 'url', url: 'http://192.168.1.1' })
  })

  it('refuses javascript: and vbscript:, falling back to search', () => {
    // Self-XSS defence: a pasted javascript: URL must never execute in the
    // context of the current page.
    expect(resolve('javascript:alert(document.cookie)').kind).toBe('search')
    expect(resolve('JavaScript:alert(1)').kind).toBe('search')
    expect(resolve('vbscript:msgbox(1)').kind).toBe('search')
  })

  it('passes non-navigable schemes through for the guards to handle', () => {
    expect(resolve('mailto:someone@example.com')).toEqual({
      kind: 'url',
      url: 'mailto:someone@example.com'
    })
  })

  it('maps empty input to the new tab page', () => {
    expect(resolve('')).toEqual({ kind: 'internal', url: NEW_TAB_URL })
    expect(resolve('   ')).toEqual({ kind: 'internal', url: NEW_TAB_URL })
  })

  it('recognises internal urls', () => {
    expect(resolve(NEW_TAB_URL)).toEqual({ kind: 'internal', url: NEW_TAB_URL })
  })

  it('searches a query that merely contains a url-like token', () => {
    expect(resolve('what is example.com used for').kind).toBe('search')
  })

  it('honours the configured search engine', () => {
    const result = resolveInput('typescript', 'google')
    expect(result.url).toBe('https://www.google.com/search?q=typescript')
  })

  it('encodes search queries so & and = cannot inject extra parameters', () => {
    const result = resolve('a&b=c d')
    expect(result.url).toBe('https://duckduckgo.com/?q=a%26b%3Dc%20d')
  })
})

describe('formatUrlForDisplay', () => {
  it('strips the scheme and a lone trailing slash', () => {
    expect(formatUrlForDisplay('https://example.com/')).toBe('example.com')
    expect(formatUrlForDisplay('https://example.com/docs/')).toBe('example.com/docs/')
  })

  it('keeps path, query and hash', () => {
    expect(formatUrlForDisplay('https://example.com/a?b=1#c')).toBe('example.com/a?b=1#c')
  })

  it('leaves non-http urls and unparseable input untouched', () => {
    expect(formatUrlForDisplay('adaptive://newtab')).toBe('adaptive://newtab')
    expect(formatUrlForDisplay('not a url')).toBe('not a url')
  })
})

describe('custom search engines with keyword prefixes', () => {
  const engines = [
    { id: 'gh', name: 'GitHub', keyword: 'gh', url: 'https://github.com/search?q=%s' },
    { id: 'w', name: 'Wikipedia', keyword: 'w', url: 'https://en.wikipedia.org/w/index.php?search=%s' },
    // Deliberately missing a placeholder, which is the commonest way to get
    // this wrong when adding an engine by hand.
    { id: 'noph', name: 'No placeholder', keyword: 'np', url: 'https://example.com/find' }
  ]
  const resolveWith = (input: string) => resolveInput(input, 'google', engines)

  it('sends the rest of the line to the named engine', () => {
    const result = resolveWith('gh react hooks')
    expect(result.kind).toBe('search')
    expect(result.url).toBe('https://github.com/search?q=react%20hooks')
  })

  it('keeps the query free of the keyword itself', () => {
    const result = resolveWith('gh react hooks')
    expect(result.kind === 'search' && result.query).toBe('react hooks')
  })

  it('does not hijack a domain that starts with a keyword', () => {
    // The whole reason a trailing space is required. Without it a keyword of
    // "gh" would swallow github.com and the user could never reach the site.
    expect(resolveWith('github.com').kind).toBe('url')
    expect(resolveWith('gh.example.com').kind).toBe('url')
    expect(resolveWith('w3.org').kind).toBe('url')
  })

  it('treats a bare keyword as ordinary input, not an empty search', () => {
    // "w" alone is far more likely to be the start of something than a request
    // to search Wikipedia for nothing.
    expect(resolveWith('gh').url).toContain('google.com')
    expect(resolveWith('gh   ').url).toContain('google.com')
  })

  it('appends the query when the engine URL has no placeholder', () => {
    expect(resolveWith('np widgets').url).toBe('https://example.com/find?q=widgets')
  })

  it('matches the keyword case-insensitively', () => {
    expect(resolveWith('GH react').url).toBe('https://github.com/search?q=react')
  })

  it('falls back to the default engine when no keyword matches', () => {
    expect(resolveWith('zz something').url).toContain('google.com')
  })

  it('leaves ordinary resolution alone when no engines are configured', () => {
    expect(resolveInput('gh react', 'google').url).toContain('google.com')
    expect(resolveInput('example.com', 'google').kind).toBe('url')
  })

  it('never lets a keyword turn a blocked scheme into a navigation', () => {
    // A keyword search of a javascript: URL is still a search, not a navigation.
    const result = resolveWith('gh javascript:alert(1)')
    expect(result.kind).toBe('search')
    expect(result.url.startsWith('https://github.com/')).toBe(true)
  })
})

describe('a custom engine as the default', () => {
  // The capability a search partnership needs: the deal pays against a URL
  // carrying your code, and it only earns if searches actually go there rather
  // than needing a keyword typed first.
  const partner = [
    {
      id: 'ecosia-partner',
      name: 'Ecosia',
      keyword: 'ec',
      url: 'https://www.ecosia.org/search?q=%s&tt=slashbrowser'
    }
  ]

  it('sends plain searches to the custom default, partner code intact', () => {
    const result = resolveInput('climate news', 'ecosia-partner', partner)
    expect(result.kind).toBe('search')
    expect(result.url).toBe('https://www.ecosia.org/search?q=climate%20news&tt=slashbrowser')
  })

  it('still resolves addresses as addresses', () => {
    expect(resolveInput('example.com', 'ecosia-partner', partner).kind).toBe('url')
  })

  it('falls back to the schema default when the id matches nothing', () => {
    // A profile naming a deleted engine must not search somewhere arbitrary.
    const result = resolveInput('cats', 'deleted-engine', partner)
    expect(result.url).toContain('google.com')
  })

  it('appends the query when a custom default has no placeholder', () => {
    const noPlaceholder = [{ id: 'np', name: 'NP', keyword: 'np', url: 'https://example.com/find' }]
    expect(resolveInput('widgets', 'np', noPlaceholder).url).toBe(
      'https://example.com/find?q=widgets'
    )
  })

  it('keeps built-in ids working exactly as before', () => {
    expect(resolveInput('cats', 'bing', partner).url).toBe('https://www.bing.com/search?q=cats')
  })
})
