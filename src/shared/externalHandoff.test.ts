import { describe, it, expect } from 'vitest'
import { handoffHintFor } from './externalHandoff'

describe('handoffHintFor', () => {
  it('stays quiet on Google sign-in, which works here', () => {
    // Reversed deliberately. This used to assert a hint saying Google refuses
    // sign-in from Slash, and `SLASH_GOOGLE_UA_PROBE` measured that as false:
    // Slash's user agent carries no `Electron` token and Google's real sign-in
    // form loads with `blocked: false`. The notice also caused the bug it
    // claimed to explain, by pushing people to finish a sign-in in a different
    // browser than they began it in, which loses the provider's flow state.
    expect(handoffHintFor('https://accounts.google.com/v3/signin/identifier')).toBeNull()
    expect(handoffHintFor('https://sub.accounts.google.com/signin')).toBeNull()
    expect(handoffHintFor('https://WWW.Accounts.Google.com/signin')).toBeNull()
  })

  it('does not fire on ordinary Google pages', () => {
    expect(handoffHintFor('https://www.google.com/search?q=test')).toBeNull()
    expect(handoffHintFor('https://docs.google.com/document/d/abc')).toBeNull()
  })

  it('matches subdomains of a host that is listed', () => {
    // The matcher itself still has to work; `claude.ai` is the listed host now.
    expect(handoffHintFor('https://claude.ai/login')).not.toBeNull()
  })

  it('does not match a host that merely ends with the same text', () => {
    expect(handoffHintFor('https://notclaude.ai.evil.example/login')).toBeNull()
  })

  it('returns null for unlisted sites and unparseable input', () => {
    expect(handoffHintFor('https://example.com')).toBeNull()
    expect(handoffHintFor('slash://newtab')).toBeNull()
    expect(handoffHintFor('not a url')).toBeNull()
    expect(handoffHintFor('')).toBeNull()
  })
})

describe('scoped hints', () => {
  it('offers the hand-off on Claude sign-in', () => {
    // Measured: Claude signs in with Google through FedCM, which needs an
    // account chooser the *browser* renders. Electron does not implement it, so
    // the call fails with "Provider's accounts list is empty".
    const hint = handoffHintFor('https://claude.ai/login?returnTo=%2F')
    expect(hint).not.toBeNull()
    expect(hint?.reason).toMatch(/FedCM/)
  })

  it('stays quiet on the rest of the site', () => {
    // A browser that offers to send you elsewhere on every page of a service
    // you are already signed into is nagging, not helping.
    expect(handoffHintFor('https://claude.ai/chats')).toBeNull()
    expect(handoffHintFor('https://claude.ai/')).toBeNull()
  })

  it('is case-insensitive and ignores a leading www on a listed host', () => {
    expect(handoffHintFor('https://WWW.Claude.ai/login')).not.toBeNull()
  })
})
