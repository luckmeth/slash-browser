import { describe, it, expect } from 'vitest'
import {
  decideRedirect,
  isExemptHost,
  trimChain,
  type NavigationHop,
  type RedirectFacts
} from './RedirectChainMonitor'

const hop = (host: string, at: number, msSinceGesture: number | null = null): NavigationHop => ({
  host,
  at,
  msSinceGesture
})

const facts = (over: Partial<RedirectFacts> = {}): RedirectFacts => ({
  chain: [hop('news.example.com', 0)],
  mode: 'standard',
  targetIsKnownAd: false,
  siteLocked: false,
  isCrossSite: false,
  ...over
})

describe('isExemptHost', () => {
  it('recognises identity, payment and bot-check hosts', () => {
    expect(isExemptHost('accounts.google.com')).toBe(true)
    expect(isExemptHost('login.microsoftonline.com')).toBe(true)
    expect(isExemptHost('checkout.stripe.com')).toBe(true)
    expect(isExemptHost('challenges.cloudflare.com')).toBe(true)
  })

  it('covers subdomains and ignores a leading www', () => {
    expect(isExemptHost('eu.checkout.stripe.com')).toBe(true)
    expect(isExemptHost('www.paypal.com')).toBe(true)
  })

  it('does not match a lookalike host', () => {
    expect(isExemptHost('stripe.com.evil.example')).toBe(false)
    expect(isExemptHost('notpaypal.com')).toBe(false)
  })
})

describe('decideRedirect', () => {
  it('never interferes with a sign-in flow, however fast the hops', () => {
    // The exact shape the heuristics look for — three cross-site hops in under a
    // second with no click. A browser that blocks this does not work.
    const oauth = [
      hop('shop.example.com', 0),
      hop('accounts.google.com', 120),
      hop('accounts.google.com', 300)
    ]
    expect(decideRedirect(facts({ chain: oauth, isCrossSite: true })).action).toBe('allow')
  })

  it('allows the return leg from an identity provider', () => {
    const back = [hop('accounts.google.com', 0), hop('shop.example.com', 200)]
    expect(decideRedirect(facts({ chain: back, isCrossSite: true })).reason).toBe(
      'exempt-known-flow'
    )
  })

  it('allows a payment redirect in strict mode', () => {
    const pay = [hop('shop.example.com', 0), hop('checkout.stripe.com', 90)]
    expect(decideRedirect(facts({ chain: pay, mode: 'strict', isCrossSite: true })).action).toBe(
      'allow'
    )
  })

  it('blocks an unclicked jump to a known ad destination', () => {
    // The one case with an actual rule behind it, so the one case that blocks.
    const verdict = decideRedirect(
      facts({ chain: [hop('video.example.com', 0), hop('adserve.example.net', 50)], targetIsKnownAd: true, isCrossSite: true })
    )
    expect(verdict).toEqual({ action: 'block', reason: 'ad-destination' })
  })

  it('allows a clicked link even to an ad destination', () => {
    const verdict = decideRedirect(
      facts({
        chain: [hop('video.example.com', 0), hop('adserve.example.net', 50, 30)],
        targetIsKnownAd: true,
        isCrossSite: true
      })
    )
    expect(verdict.action).toBe('allow')
  })

  it('warns rather than blocks on a rapid unclicked chain', () => {
    // Pattern, not rule — so it must not claim the navigation is malicious.
    const chain = [hop('a.example.com', 0), hop('b.example.net', 300), hop('c.example.org', 700)]
    expect(decideRedirect(facts({ chain, isCrossSite: true }))).toEqual({
      action: 'warn',
      reason: 'rapid-unclicked-chain'
    })
  })

  it('does not treat a slow chain as a redirect loop', () => {
    const chain = [hop('a.example.com', 0), hop('b.example.net', 4000), hop('c.example.org', 9000)]
    expect(decideRedirect(facts({ chain })).action).toBe('allow')
  })

  it('does not treat SPA routing on one host as a chain', () => {
    // Same host rewriting its URL is a router, not a redirect.
    const chain = [hop('app.example.com', 0), hop('app.example.com', 100), hop('app.example.com', 200)]
    expect(decideRedirect(facts({ chain })).action).toBe('allow')
  })

  it('does not flag a chain the user clicked through', () => {
    const chain = [hop('a.example.com', 0, 10), hop('b.example.net', 300, 20), hop('c.example.org', 700, 15)]
    expect(decideRedirect(facts({ chain, isCrossSite: true })).reason).toBe('user-initiated')
  })

  it('blocks unclicked cross-site navigation when the tab is locked', () => {
    const chain = [hop('video.example.com', 0), hop('elsewhere.example.net', 200)]
    expect(decideRedirect(facts({ chain, siteLocked: true, isCrossSite: true }))).toEqual({
      action: 'block',
      reason: 'site-locked'
    })
  })

  it('lets the user click their way out of a locked tab', () => {
    const chain = [hop('video.example.com', 0), hop('elsewhere.example.net', 200, 25)]
    expect(decideRedirect(facts({ chain, siteLocked: true, isCrossSite: true })).action).toBe(
      'allow'
    )
  })

  it('warns on unclicked cross-site navigation in strict mode only', () => {
    const chain = [hop('a.example.com', 0), hop('b.example.net', 3000)]
    expect(decideRedirect(facts({ chain, isCrossSite: true, mode: 'standard' })).action).toBe(
      'allow'
    )
    expect(decideRedirect(facts({ chain, isCrossSite: true, mode: 'strict' })).action).toBe('warn')
  })

  it('keeps the chain bounded', () => {
    const long = Array.from({ length: 50 }, (_, i) => hop(`h${i}.example.com`, i * 10))
    expect(trimChain(long).length).toBe(6)
    expect(trimChain(long).at(-1)?.host).toBe('h49.example.com')
  })

  it('handles an empty chain', () => {
    expect(decideRedirect(facts({ chain: [] })).action).toBe('allow')
  })
})
