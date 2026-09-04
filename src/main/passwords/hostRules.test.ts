import { describe, it, expect } from 'vitest'
import { normaliseHost } from './hostRules'

describe('normaliseHost', () => {
  it('treats www and the bare domain as the same site', () => {
    // Sites move between these freely and nobody thinks of them as two
    // accounts, so a sign-in saved on one must be offered on the other.
    expect(normaliseHost('www.example.com')).toBe('example.com')
    expect(normaliseHost('example.com')).toBe('example.com')
  })

  it('accepts a full URL as readily as a bare host', () => {
    expect(normaliseHost('https://www.example.com/login?next=/account')).toBe('example.com')
    expect(normaliseHost('http://example.com:8080/x')).toBe('example.com')
  })

  it('is case-insensitive', () => {
    expect(normaliseHost('WWW.Example.COM')).toBe('example.com')
  })

  it('keeps a subdomain that is not www', () => {
    // accounts.google.com is a different sign-in from mail.google.com, and
    // collapsing them would offer the wrong credentials.
    expect(normaliseHost('accounts.google.com')).toBe('accounts.google.com')
    expect(normaliseHost('https://mail.google.com/')).toBe('mail.google.com')
  })

  it('only strips a leading www, not one in the middle', () => {
    expect(normaliseHost('www.www.example.com')).toBe('www.example.com')
    expect(normaliseHost('notwww.example.com')).toBe('notwww.example.com')
  })

  it('returns empty for empty or whitespace input', () => {
    expect(normaliseHost('')).toBe('')
    expect(normaliseHost('   ')).toBe('')
  })

  it('degrades to the trimmed text rather than throwing on a malformed URL', () => {
    // A stored value that will not parse must not crash the vault; the worst
    // outcome should be that no sign-in matches.
    expect(normaliseHost('://broken')).not.toBe('')
    expect(() => normaliseHost('http://')).not.toThrow()
  })
})
