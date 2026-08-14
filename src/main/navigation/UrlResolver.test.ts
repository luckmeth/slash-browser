import { describe, it, expect } from 'vitest'
import { resolveInput } from './UrlResolver'
import { formatUrlForDisplay } from '@shared/url'
import { NEW_TAB_URL } from '@shared/types/tab'

const resolve = (input: string) => resolveInput(input, 'duckduckgo')

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
