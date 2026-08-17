import type { InsightSignal, ShoppingInsight } from '@shared/types/pageInsight'

/**
 * Turning what was scraped off a page into findings.
 *
 * Pure, so every claim this panel makes about a page is pinned to a test. That
 * matters more here than anywhere else in the browser: these findings are
 * assertions about someone else's honesty, and a false positive accuses a
 * legitimate site of hiding an affiliate deal.
 *
 * The vocabulary is therefore fixed. `declared` findings come from markup the
 * page published about itself and can be stated plainly. `detected` findings come
 * from pattern matching and are always hedged.
 */

/**
 * Affiliate-network URL patterns.
 *
 * Deliberately narrow — these are the parameter and host conventions the major
 * networks actually use. A looser rule (any `?ref=`) would flag ordinary
 * analytics and internal campaign links, and being wrong about this is worse
 * than missing one.
 */
const AFFILIATE_PATTERNS: ReadonlyArray<{ pattern: RegExp; network: string }> = [
  { pattern: /[?&]tag=[^&]+/i, network: 'Amazon Associates' },
  { pattern: /amzn\.to\//i, network: 'Amazon short link' },
  { pattern: /(^|\.)shareasale\.com/i, network: 'ShareASale' },
  { pattern: /(^|\.)awin1?\.com/i, network: 'Awin' },
  { pattern: /(^|\.)clickbank\.net/i, network: 'ClickBank' },
  { pattern: /(^|\.)skimresources\.com/i, network: 'Skimlinks' },
  { pattern: /(^|\.)viglink\.com/i, network: 'VigLink' },
  { pattern: /(^|\.)impact(radius)?(-go)?\.com/i, network: 'Impact' },
  { pattern: /(^|\.)cj\.(com|dotomi\.com)/i, network: 'CJ Affiliate' },
  { pattern: /[?&]irclickid=/i, network: 'Impact' },
  { pattern: /[?&](affid|affiliate_id|aff_id)=/i, network: 'affiliate parameter' }
]

/**
 * Phrases a page uses when it is disclosing a commercial relationship.
 *
 * Split by how much they prove, because getting this wrong accuses an honest
 * site. A live probe caught the original version reporting Wikipedia's *article
 * about* affiliate marketing as an affiliate disclosure, on the strength of the
 * words "affiliate link" appearing as its subject matter — and reporting it at
 * `declared`, the strongest form. Bare topic words are gone.
 *
 * `SELF_DISCLOSURE` phrases are first-person statements a page makes about
 * itself and cannot plausibly be subject matter. Everything else is a weaker
 * label that often marks a section, so it is reported as `detected`.
 */
const SELF_DISCLOSURE_PHRASES = [
  'we may earn a commission',
  'we earn a commission',
  'may earn an affiliate commission',
  'this post contains affiliate',
  'this article contains affiliate',
  'contains affiliate links',
  'affiliate disclosure',
  'paid partnership'
] as const

const WEAK_COMMERCIAL_PHRASES = ['sponsored post', 'sponsored content', 'advertorial'] as const

/** Phrases that manufacture urgency. Presence is a signal, not a verdict. */
const URGENCY_PHRASES = [
  'only .{0,12} left',
  'hurry',
  'ends (today|soon|tonight)',
  'limited time',
  'last chance',
  'while stocks last',
  'selling fast',
  'act now',
  'don.?t miss out',
  'offer expires',
  '\\d+ (people|others) (are )?(viewing|watching|bought)'
] as const

/** Phrases indicating a recurring charge rather than a one-off purchase. */
const SUBSCRIPTION_PHRASES = [
  'per month',
  'per year',
  '/month',
  '/mo',
  '/yr',
  'auto-renew',
  'automatically renew',
  'recurring',
  'billed monthly',
  'billed annually',
  'subscription',
  'free trial'
] as const

export interface LinkFact {
  url: string
  host: string
  /** The anchor's `rel` attribute, lowercased, or ''. */
  rel: string
}

/**
 * Affiliate and sponsorship findings.
 *
 * `rel="sponsored"` is a declaration by the page under a web standard, so it is
 * reported as `declared`. A matched URL pattern is only ever `detected` — plenty
 * of legitimate links carry a partner parameter, and the panel must not imply
 * the site did something wrong.
 */
export function findCommercialSignals(
  links: readonly LinkFact[],
  visibleText: string
): InsightSignal[] {
  const signals: InsightSignal[] = []
  const text = visibleText.toLowerCase()

  const sponsoredRel = links.filter((link) => /\bsponsored\b/.test(link.rel))
  if (sponsoredRel.length > 0) {
    signals.push({
      label: 'Sponsored links',
      detail: `${sponsoredRel.length} link${sponsoredRel.length === 1 ? '' : 's'} on this page ${sponsoredRel.length === 1 ? 'is' : 'are'} marked rel="sponsored" by the page itself.`,
      strength: 'declared'
    })
  }

  const networks = new Set<string>()
  let affiliateCount = 0
  for (const link of links) {
    for (const { pattern, network } of AFFILIATE_PATTERNS) {
      if (pattern.test(link.url) || pattern.test(link.host)) {
        networks.add(network)
        affiliateCount++
        break
      }
    }
  }
  if (affiliateCount > 0) {
    signals.push({
      label: 'Possible affiliate links',
      detail: `${affiliateCount} link${affiliateCount === 1 ? '' : 's'} match${affiliateCount === 1 ? 'es' : ''} the URL conventions of ${[...networks].join(', ')}. The site may earn a commission if you buy through them. This is common and not itself a problem.`,
      strength: 'detected'
    })
  }

  const selfDisclosure = SELF_DISCLOSURE_PHRASES.find((phrase) => text.includes(phrase))
  if (selfDisclosure) {
    signals.push({
      label: 'Commercial disclosure',
      detail: `The page states “${selfDisclosure}”, so it is disclosing a paid or commission-earning relationship.`,
      strength: 'declared'
    })
  } else {
    const weak = WEAK_COMMERCIAL_PHRASES.find((phrase) => text.includes(phrase))
    if (weak) {
      signals.push({
        label: 'Promotional wording',
        // Hedged, because these words are as likely to be the topic as the
        // disclosure — an article about advertising discusses sponsored content.
        detail: `The phrase “${weak}” appears on this page. That may label promotional material, or it may simply be what the page is about.`,
        strength: 'detected'
      })
    }
  }

  return signals
}

/** Urgency and pressure patterns found in visible text. */
export function findUrgencySignals(visibleText: string): InsightSignal[] {
  const text = visibleText.toLowerCase()
  const matched: string[] = []
  for (const phrase of URGENCY_PHRASES) {
    const match = new RegExp(phrase, 'i').exec(text)
    if (match) matched.push(match[0].trim())
  }
  if (matched.length === 0) return []

  return [
    {
      label: 'Urgency wording',
      // Hedged deliberately: a genuine sale really does end on Sunday. The
      // finding is that the language is present, not that the claim is false.
      detail: `Phrases that create time pressure appear on this page (${matched
        .slice(0, 3)
        .map((phrase) => `“${phrase}”`)
        .join(', ')}). Worth checking whether the deadline is real before deciding.`,
      strength: 'detected'
    }
  ]
}

/**
 * How well the page supports what it says.
 *
 * Only two things are honestly measurable from markup: whether it links out at
 * all, and whether it links to many independent places. That is reported as
 * sourcing, and explicitly *not* as accuracy — a page can cite forty sources and
 * be wrong, and this cannot tell the difference.
 */
export function findSourcingSignals(
  externalLinkCount: number,
  linkedHosts: readonly string[],
  wordCount: number
): InsightSignal[] {
  if (wordCount < 300) return []

  if (externalLinkCount === 0) {
    return [
      {
        label: 'No outbound sources',
        detail:
          'This page of about ' +
          `${wordCount} words links to no other sites, so nothing on it can be followed up. That is normal for opinion and original writing, and a gap for anything factual.`,
        strength: 'detected'
      }
    ]
  }
  if (linkedHosts.length >= 5) {
    return [
      {
        label: 'Links to several sources',
        detail: `Links out to ${linkedHosts.length} different sites, including ${linkedHosts.slice(0, 3).join(', ')}. Linking is not the same as supporting — follow them to check.`,
        strength: 'detected'
      }
    ]
  }
  return []
}

export interface ShoppingFacts {
  productName: string | null
  price: string | null
  availability: string | null
  visibleText: string
}

/**
 * Shopping details, when the page looks like a product page.
 *
 * Price is taken from the page's own structured data and reported **as written**.
 * Never recomputed, never converted: a browser showing a different number from
 * the page is a bug of the worst kind on a checkout screen.
 */
export function readShoppingInsight(facts: ShoppingFacts): ShoppingInsight | null {
  if (facts.productName === null && facts.price === null) return null
  const text = facts.visibleText.toLowerCase()

  return {
    productName: facts.productName,
    price: facts.price,
    availability: facts.availability,
    subscription: SUBSCRIPTION_PHRASES.some((phrase) => text.includes(phrase)),
    mentionsReturns: /\b(returns?|refund)\b/.test(text),
    mentionsCancellation: /\bcancel(lation|ling|led)?\b/.test(text)
  }
}

/** Rounded reading time at 230 words per minute. */
export function readingMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 230))
}

/**
 * Hosts linked from the page, most linked first, excluding the page's own.
 *
 * Self-links are removed because every site links to itself constantly, and a
 * list led by the host you are already on tells the user nothing.
 */
export function rankLinkedHosts(links: readonly LinkFact[], pageHost: string): string[] {
  const own = pageHost.toLowerCase().replace(/^www\./, '')
  const counts = new Map<string, number>()
  for (const link of links) {
    const host = link.host.toLowerCase().replace(/^www\./, '')
    if (host === '' || host === own) continue
    counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([host]) => host)
}
