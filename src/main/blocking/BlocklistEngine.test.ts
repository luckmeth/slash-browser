import { describe, it, expect, beforeEach } from 'vitest'
import { BlocklistEngine } from './BlocklistEngine'

describe('BlocklistEngine', () => {
  let engine: BlocklistEngine

  beforeEach(() => {
    engine = new BlocklistEngine()
    engine.loadBlocked(['doubleclick.net', 'google-analytics.com', 'criteo.com'])
    engine.loadMalicious(['evil.example', 'phishing.testing.google.test'])
  })

  it('blocks a third-party request to a listed domain', () => {
    expect(engine.shouldBlockRequest('doubleclick.net', 'news.example')).toBe(true)
  })

  it('blocks subdomains of a listed domain', () => {
    // A rule for the domain has to cover its subdomains, or the list is
    // trivially defeated by using a new hostname.
    expect(engine.shouldBlockRequest('stats.g.doubleclick.net', 'news.example')).toBe(true)
    expect(engine.shouldBlockRequest('ssl.google-analytics.com', 'news.example')).toBe(true)
  })

  it('leaves unlisted domains alone', () => {
    expect(engine.shouldBlockRequest('cdn.example.org', 'news.example')).toBe(false)
  })

  it('does not block a first-party request even to a listed domain', () => {
    // Visiting an ad network's own site should work. Blocking it would look
    // like the browser is broken rather than like protection.
    expect(engine.shouldBlockRequest('criteo.com', 'criteo.com')).toBe(false)
    expect(engine.shouldBlockRequest('www.criteo.com', 'criteo.com')).toBe(false)
    expect(engine.shouldBlockRequest('assets.criteo.com', 'criteo.com')).toBe(false)
  })

  it('ignores a leading www and is case-insensitive', () => {
    expect(engine.shouldBlockRequest('WWW.DoubleClick.net', 'news.example')).toBe(true)
  })

  it('does not treat a domain that merely ends in a listed name as a match', () => {
    // "notdoubleclick.net" must not match "doubleclick.net" — only a real
    // subdomain boundary counts.
    expect(engine.shouldBlockRequest('notdoubleclick.net', 'news.example')).toBe(false)
    expect(engine.shouldBlockRequest('evildoubleclick.net', 'news.example')).toBe(false)
  })

  it('recognises malicious hosts and their subdomains', () => {
    expect(engine.isMalicious('evil.example')).toBe(true)
    expect(engine.isMalicious('login.evil.example')).toBe(true)
    expect(engine.isMalicious('fine.example')).toBe(false)
  })

  it('honours a per-site exemption', () => {
    engine.setAllowedSites(['news.example'])
    expect(engine.isSiteAllowed('news.example')).toBe(true)
    expect(engine.isSiteAllowed('other.example')).toBe(false)
  })

  it('applies an exemption to subdomains of the allowed site', () => {
    engine.setAllowedSites(['example.com'])
    expect(engine.isSiteAllowed('shop.example.com')).toBe(true)
  })

  it('handles empty and malformed hosts without throwing', () => {
    expect(engine.shouldBlockRequest('', 'news.example')).toBe(false)
    expect(engine.shouldBlockRequest('doubleclick.net', '')).toBe(false)
    expect(engine.isMalicious('')).toBe(false)
  })
})
