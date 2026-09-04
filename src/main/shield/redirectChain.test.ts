import { describe, it, expect } from 'vitest'
import type { RedirectHop } from '@shared/types/redirectChain'
import { classifyChain, domainOf, isWorthReporting, kindForStatus, looksLikeAuthStep } from './redirectChain'

const hop = (url: string, statusCode: number | null = 302): RedirectHop => ({
  url,
  host: (() => {
    try {
      return new URL(url).host
    } catch {
      return ''
    }
  })(),
  kind: kindForStatus(statusCode),
  statusCode,
  at: 0
})

const noAds = (): boolean => false
const adHosts = (host: string): boolean => /doubleclick|adnxs|taboola/.test(host)

describe('domainOf', () => {
  it('reduces a host to its registrable domain', () => {
    expect(domainOf('login.eu.example.com')).toBe('example.com')
    expect(domainOf('www.example.co.uk')).toBe('example.co.uk')
  })
})

describe('kindForStatus', () => {
  it('separates permanent from temporary', () => {
    expect(kindForStatus(301)).toBe('permanent')
    expect(kindForStatus(308)).toBe('permanent')
    expect(kindForStatus(302)).toBe('temporary')
    expect(kindForStatus(307)).toBe('temporary')
    expect(kindForStatus(null)).toBe('unknown')
  })
})

describe('looksLikeAuthStep', () => {
  it('recognises the major identity providers', () => {
    expect(looksLikeAuthStep('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true)
    expect(looksLikeAuthStep('https://login.microsoftonline.com/common/oauth2/authorize')).toBe(true)
    expect(looksLikeAuthStep('https://appleid.apple.com/auth/authorize')).toBe(true)
    expect(looksLikeAuthStep('https://mycompany.okta.com/app/x')).toBe(true)
  })

  it('recognises payment and 3-D Secure hosts', () => {
    expect(looksLikeAuthStep('https://checkout.stripe.com/pay/cs_test')).toBe(true)
    expect(looksLikeAuthStep('https://www.paypal.com/checkoutnow')).toBe(true)
    expect(looksLikeAuthStep('https://secure.cardinalcommerce.com/3ds')).toBe(true)
  })

  it('recognises a self-hosted provider by its URL shape', () => {
    // OAuth's URL shape is standardised even when the domain is not, so a bank's
    // own SSO or a self-hosted Keycloak is still caught.
    expect(looksLikeAuthStep('https://id.somebank.example/oauth2/authorize?client_id=x')).toBe(true)
    expect(looksLikeAuthStep('https://intranet.example.org/saml/login')).toBe(true)
  })

  it('does not treat an ordinary page as an auth step', () => {
    expect(looksLikeAuthStep('https://example.com/blog/post')).toBe(false)
    expect(looksLikeAuthStep('https://doubleclick.net/track?id=1')).toBe(false)
  })
})

describe('classifyChain', () => {
  it('says nothing about a direct navigation', () => {
    const result = classifyChain([hop('https://example.com/page', null)], noAds)
    expect(result.verdict).toBe('ordinary')
    expect(result.reasons[0]).toContain('No redirects')
  })

  it('treats a sign-in flow as authentication, never suspicious', () => {
    // The load-bearing case. OAuth crosses several domains by design, and a
    // warning here would train the user to dismiss every redirect warning.
    const chain = [
      hop('https://app.example.com/login', null),
      hop('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'),
      hop('https://accounts.google.com/signin/challenge'),
      hop('https://app.example.com/callback?code=abc'),
      hop('https://app.example.com/dashboard')
    ]
    const result = classifyChain(chain, noAds)
    expect(result.verdict).toBe('authentication')
    expect(result.reasons[0]).toContain('normal and expected')
    expect(isWorthReporting(result.verdict)).toBe(false)
  })

  it('keeps treating a payment chain as authentication even when it is long', () => {
    const chain = [
      hop('https://shop.example/checkout', null),
      hop('https://checkout.stripe.com/pay/cs_1'),
      hop('https://secure.cardinalcommerce.com/3ds/step'),
      hop('https://bank.example/3ds/challenge'),
      hop('https://checkout.stripe.com/return'),
      hop('https://shop.example/order/complete')
    ]
    expect(classifyChain(chain, noAds).verdict).toBe('authentication')
  })

  it('flags a chain routed through a tracking host', () => {
    const chain = [
      hop('https://blog.example/post', null),
      hop('https://ad.doubleclick.net/click?u=x'),
      hop('https://shop.example/product')
    ]
    const result = classifyChain(chain, adHosts)
    expect(result.verdict).toBe('suspicious')
    expect(result.reasons[0]).toContain('doubleclick.net')
    expect(isWorthReporting(result.verdict)).toBe(true)
  })

  it('calls an unfamiliar long chain notable, not suspicious', () => {
    // Not recognising a host is not evidence against it. Reserving "suspicious"
    // for positive evidence is what keeps the label meaningful.
    const chain = [
      hop('https://a.example/start', null),
      hop('https://b.example/x'),
      hop('https://c.example/y'),
      hop('https://d.example/z'),
      hop('https://e.example/final')
    ]
    const result = classifyChain(chain, noAds)
    expect(result.verdict).toBe('notable')
    expect(result.reasons.join(' ')).toContain('4 redirects')
  })

  it('notes when a chain lands on a different domain', () => {
    const chain = [
      hop('https://short.example/abc', null),
      hop('https://elsewhere.example/landing')
    ]
    expect(classifyChain(chain, noAds).reasons.join(' ')).toContain('finished on elsewhere.example')
  })

  it('does not call an in-site redirect notable', () => {
    // http→https and trailing-slash redirects are the most common on the web and
    // must produce no noise at all.
    const chain = [
      hop('http://example.com', null),
      hop('https://example.com/'),
      hop('https://example.com/home')
    ]
    const result = classifyChain(chain, noAds)
    expect(result.verdict).toBe('ordinary')
  })

  it('lists the domains crossed in order', () => {
    const result = classifyChain(
      [hop('https://a.example/1', null), hop('https://b.example/2'), hop('https://a.example/3')],
      noAds
    )
    expect(result.domains).toEqual(['a.example', 'b.example'])
  })

  it('survives an unparseable URL', () => {
    expect(() => classifyChain([hop('not a url', null)], noAds)).not.toThrow()
  })
})
