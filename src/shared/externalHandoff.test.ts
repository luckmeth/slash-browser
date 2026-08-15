import { describe, it, expect } from 'vitest'
import { handoffHintFor } from './externalHandoff'

describe('handoffHintFor', () => {
  it('recognises the Google sign-in host', () => {
    const hint = handoffHintFor('https://accounts.google.com/v3/signin/rejected?continue=x')
    expect(hint).not.toBeNull()
    expect(hint?.host).toBe('accounts.google.com')
  })

  it('matches subdomains of a listed host', () => {
    expect(handoffHintFor('https://sub.accounts.google.com/signin')).not.toBeNull()
  })

  it('ignores a leading www and is case-insensitive', () => {
    expect(handoffHintFor('https://WWW.Accounts.Google.com/signin')).not.toBeNull()
  })

  it('does not fire on ordinary Google pages', () => {
    // Search and Docs work fine; only the sign-in flow is refused, and a notice
    // on every Google page would be noise.
    expect(handoffHintFor('https://www.google.com/search?q=test')).toBeNull()
    expect(handoffHintFor('https://docs.google.com/document/d/abc')).toBeNull()
  })

  it('does not match a host that merely ends with the same text', () => {
    expect(handoffHintFor('https://notaccounts.google.com.evil.example/')).toBeNull()
  })

  it('returns null for unlisted sites and unparseable input', () => {
    expect(handoffHintFor('https://example.com')).toBeNull()
    expect(handoffHintFor('slash://newtab')).toBeNull()
    expect(handoffHintFor('not a url')).toBeNull()
    expect(handoffHintFor('')).toBeNull()
  })
})
