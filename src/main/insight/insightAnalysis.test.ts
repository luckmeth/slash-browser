import { describe, it, expect } from 'vitest'
import {
  findCommercialSignals,
  findSourcingSignals,
  findUrgencySignals,
  rankLinkedHosts,
  readShoppingInsight,
  readingMinutes,
  type LinkFact
} from './insightAnalysis'

const link = (url: string, rel = ''): LinkFact => ({
  url,
  host: (() => {
    try {
      return new URL(url).host
    } catch {
      return ''
    }
  })(),
  rel
})

describe('findCommercialSignals', () => {
  it('reports rel="sponsored" as declared by the page', () => {
    // A web standard the page opted into, so it can be stated plainly.
    const signals = findCommercialSignals([link('https://shop.example/x', 'nofollow sponsored')], '')
    expect(signals[0]!.strength).toBe('declared')
    expect(signals[0]!.detail).toContain('rel="sponsored"')
  })

  it('detects affiliate URL conventions and names the network', () => {
    const signals = findCommercialSignals(
      [link('https://www.amazon.com/dp/B01?tag=someblog-20')],
      ''
    )
    const affiliate = signals.find((signal) => signal.label === 'Possible affiliate links')
    expect(affiliate?.strength).toBe('detected')
    expect(affiliate?.detail).toContain('Amazon Associates')
  })

  it('never implies an affiliate link is wrongdoing', () => {
    // Affiliate links are ordinary. Accusing a legitimate site is the failure
    // that matters most here.
    const signals = findCommercialSignals([link('https://amzn.to/abc')], '')
    const text = signals.map((s) => s.detail).join(' ').toLowerCase()
    expect(text).toContain('not itself a problem')
    expect(text).not.toContain('deceptive')
    expect(text).not.toContain('scam')
  })

  it('reads a first-person disclosure as declared', () => {
    const signals = findCommercialSignals([], 'This post contains affiliate links to products.')
    const disclosure = signals.find((signal) => signal.label === 'Commercial disclosure')
    expect(disclosure?.strength).toBe('declared')
  })

  it('does not treat an article *about* affiliate marketing as a disclosure', () => {
    // Caught by a live probe: Wikipedia's article on affiliate marketing was
    // reported as declaring a commercial relationship, purely because the words
    // "affiliate link" are its subject matter. Accusing an honest site is the
    // worst failure this panel has.
    const encyclopedic =
      'An affiliate link is a URL containing a unique identifier. Affiliate links are used by ' +
      'publishers to track referrals. The affiliate marketing industry grew in the 2000s.'
    const signals = findCommercialSignals([], encyclopedic)
    expect(signals.find((signal) => signal.label === 'Commercial disclosure')).toBeUndefined()
  })

  it('hedges wording that could be either the topic or a label', () => {
    const signals = findCommercialSignals([], 'A history of sponsored content in magazines.')
    const promotional = signals.find((signal) => signal.label === 'Promotional wording')
    expect(promotional?.strength).toBe('detected')
    expect(promotional?.detail).toContain('what the page is about')
  })

  it('does not flag ordinary links', () => {
    // A looser rule (any ?ref=) would flag analytics and internal campaigns.
    expect(
      findCommercialSignals(
        [
          link('https://en.wikipedia.org/wiki/Thing'),
          link('https://example.com/page?ref=nav'),
          link('https://example.com/utm?utm_source=news')
        ],
        'An ordinary article with no commercial relationship.'
      )
    ).toEqual([])
  })

  it('counts each link once even when several patterns could match', () => {
    const signals = findCommercialSignals([link('https://amzn.to/x?tag=blog-20')], '')
    expect(signals.find((s) => s.label === 'Possible affiliate links')?.detail).toContain('1 link')
  })
})

describe('findUrgencySignals', () => {
  it('reports pressure wording without calling it a lie', () => {
    // A genuine sale really does end on Sunday.
    const signals = findUrgencySignals('Hurry — limited time offer, only 3 left in stock!')
    expect(signals).toHaveLength(1)
    expect(signals[0]!.strength).toBe('detected')
    expect(signals[0]!.detail).toContain('Worth checking whether the deadline is real')
    expect(signals[0]!.detail.toLowerCase()).not.toContain('fake')
  })

  it('quotes what it actually found', () => {
    expect(findUrgencySignals('This offer ends today.')[0]!.detail).toContain('ends today')
  })

  it('says nothing about a calm page', () => {
    expect(findUrgencySignals('A quiet article about geology.')).toEqual([])
  })
})

describe('findSourcingSignals', () => {
  it('notes when a long page links nowhere', () => {
    const signals = findSourcingSignals(0, [], 1200)
    expect(signals[0]!.label).toBe('No outbound sources')
    // Must not imply the page is wrong — plenty of good writing cites nothing.
    expect(signals[0]!.detail).toContain('normal for opinion')
  })

  it('notes when a page links widely, without calling it accurate', () => {
    const hosts = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com']
    const signals = findSourcingSignals(20, hosts, 1500)
    expect(signals[0]!.detail).toContain('Linking is not the same as supporting')
  })

  it('stays quiet on short pages', () => {
    // A 100-word page linking nothing is not a sourcing gap.
    expect(findSourcingSignals(0, [], 100)).toEqual([])
  })
})

describe('readShoppingInsight', () => {
  const facts = {
    productName: 'Laptop X1',
    price: '£1,299.00',
    availability: 'InStock',
    visibleText: 'Laptop X1. Free returns within 30 days. Cancel anytime. Billed monthly.'
  }

  it('reports the price exactly as the page wrote it', () => {
    // A browser showing a different number from the page is the worst kind of bug
    // on a checkout screen.
    expect(readShoppingInsight(facts)!.price).toBe('£1,299.00')
  })

  it('detects a recurring charge', () => {
    expect(readShoppingInsight(facts)!.subscription).toBe(true)
    expect(
      readShoppingInsight({ ...facts, visibleText: 'One-off purchase, no strings.' })!.subscription
    ).toBe(false)
  })

  it('reports whether returns and cancellation are mentioned at all', () => {
    const insight = readShoppingInsight(facts)!
    expect(insight.mentionsReturns).toBe(true)
    expect(insight.mentionsCancellation).toBe(true)

    const bare = readShoppingInsight({ ...facts, visibleText: 'Buy now.' })!
    expect(bare.mentionsReturns).toBe(false)
    expect(bare.mentionsCancellation).toBe(false)
  })

  it('returns nothing when the page is not a product page', () => {
    expect(
      readShoppingInsight({ productName: null, price: null, availability: null, visibleText: 'Blog' })
    ).toBeNull()
  })

  it('still reports a product with no price', () => {
    const insight = readShoppingInsight({ ...facts, price: null })
    expect(insight?.productName).toBe('Laptop X1')
    expect(insight?.price).toBeNull()
  })
})

describe('rankLinkedHosts', () => {
  it('excludes the page’s own host', () => {
    // Every site links to itself constantly; leading with it says nothing.
    const hosts = rankLinkedHosts(
      [link('https://example.com/a'), link('https://www.example.com/b'), link('https://other.com/c')],
      'example.com'
    )
    expect(hosts).toEqual(['other.com'])
  })

  it('orders by how often each host is linked', () => {
    const hosts = rankLinkedHosts(
      [
        link('https://b.com/1'),
        link('https://a.com/1'),
        link('https://a.com/2'),
        link('https://a.com/3')
      ],
      'page.com'
    )
    expect(hosts[0]).toBe('a.com')
  })

  it('ignores unparseable links', () => {
    expect(rankLinkedHosts([link('not a url'), link('https://a.com/x')], 'page.com')).toEqual([
      'a.com'
    ])
  })
})

describe('readingMinutes', () => {
  it('never reports zero minutes', () => {
    expect(readingMinutes(10)).toBe(1)
    expect(readingMinutes(0)).toBe(1)
  })

  it('scales with length', () => {
    expect(readingMinutes(2300)).toBe(10)
  })
})
