import {
  NOTABLE_HOP_COUNT,
  type ChainVerdict,
  type RedirectHop,
  type RedirectKind
} from '@shared/types/redirectChain'

/**
 * Classifying a redirect chain.
 *
 * Pure, and the single most safety-critical heuristic in the browser to get
 * *quiet* rather than loud. Every warning this produces is shown during a real
 * navigation, so a false positive on a sign-in flow does not merely annoy — it
 * teaches the user that redirect warnings are noise, which disarms the warning
 * for the case it exists to catch.
 *
 * Hence the ordering: authentication is recognised **first** and wins outright.
 */

/**
 * Hosts that legitimately run multi-hop cross-domain redirect chains.
 *
 * Identity providers, SSO, payment gateways and 3-D Secure. Matched on the
 * registrable domain or a suffix of the host, so `login.microsoftonline.com` and
 * `eu.login.microsoftonline.com` both count.
 *
 * This list will never be complete, which is why an unrecognised chain is
 * classified `notable` rather than `suspicious` unless there is positive evidence
 * of tracking. Not knowing a bank is not evidence against it.
 */
const AUTH_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
  'appleid.apple.com',
  'idmsa.apple.com',
  'github.com',
  'gitlab.com',
  'auth0.com',
  'okta.com',
  'oktapreview.com',
  'onelogin.com',
  'pingidentity.com',
  'duosecurity.com',
  'facebook.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'paypal.com',
  'stripe.com',
  'checkout.stripe.com',
  'adyen.com',
  'braintreegateway.com',
  'worldpay.com',
  'sagepay.com',
  'klarna.com',
  'squareup.com',
  'authorize.net',
  '3dsecure.io',
  'cardinalcommerce.com',
  'verifiedbyvisa.com',
  'securecode.com',
  'id.gov.uk',
  'signin.aws.amazon.com'
] as const

/**
 * Path fragments that mark an authorisation step.
 *
 * Catches identity providers not on the list above — a self-hosted Keycloak, a
 * bank's own SSO — because the URL shape of OAuth is standardised even when the
 * domain is not.
 */
const AUTH_PATH_MARKERS = [
  '/oauth',
  '/oauth2',
  '/authorize',
  '/authorise',
  '/openid',
  '/saml',
  '/sso',
  '/signin',
  '/sign-in',
  '/login',
  '/callback',
  '/oidc',
  '/connect/authorize',
  '/3ds',
  '/checkout'
] as const

/** Registrable-ish domain, matching the Tab Brain helper's approach. */
export function domainOf(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  const twoPart = new Set([
    'co.uk','org.uk','ac.uk','gov.uk','co.jp','com.au','co.nz','com.br','co.in','com.sg'
  ])
  return twoPart.has(lastTwo) && labels.length >= 3 ? labels.slice(-3).join('.') : lastTwo
}

/** Whether a URL is part of a recognised sign-in or payment step. */
export function looksLikeAuthStep(url: string): boolean {
  let host: string
  let path: string
  try {
    const parsed = new URL(url)
    host = parsed.host.toLowerCase()
    path = parsed.pathname.toLowerCase()
  } catch {
    return false
  }

  const matchesHost = AUTH_HOSTS.some(
    (candidate) => host === candidate || host.endsWith(`.${candidate}`) || domainOf(host) === candidate
  )
  if (matchesHost) return true
  return AUTH_PATH_MARKERS.some((marker) => path.startsWith(marker) || path.includes(marker))
}

/** HTTP status to a redirect kind. */
export function kindForStatus(statusCode: number | null): RedirectKind {
  if (statusCode === 301 || statusCode === 308) return 'permanent'
  if (statusCode === 302 || statusCode === 303 || statusCode === 307) return 'temporary'
  return 'unknown'
}

export interface ChainClassification {
  verdict: ChainVerdict
  reasons: string[]
  domains: string[]
}

/**
 * Classifies a chain.
 *
 * @param hops Every recorded step, in order, including the original URL.
 * @param isKnownAdHost Shield's existing host list — reused rather than
 *   duplicated, so the two cannot disagree about what an ad network is.
 */
export function classifyChain(
  hops: readonly RedirectHop[],
  isKnownAdHost: (host: string) => boolean
): ChainClassification {
  const domains: string[] = []
  for (const hop of hops) {
    const domain = domainOf(hop.host)
    if (domain !== '' && !domains.includes(domain)) domains.push(domain)
  }

  // Authentication wins outright, and is checked before anything else. A sign-in
  // flow is *supposed* to cross five domains; calling that suspicious would make
  // the warning worthless everywhere else.
  const authStep = hops.find((hop) => looksLikeAuthStep(hop.url))
  if (authStep) {
    return {
      verdict: 'authentication',
      reasons: [
        `This looks like a sign-in or payment flow (via ${authStep.host}). Multiple hops across different domains are normal and expected here.`
      ],
      domains
    }
  }

  const reasons: string[] = []
  const adHops = hops.filter((hop) => hop.host !== '' && isKnownAdHost(hop.host))
  if (adHops.length > 0) {
    reasons.push(
      `Routed through ${adHops.map((hop) => hop.host).join(', ')}, which ${adHops.length === 1 ? 'is' : 'are'} on a list of known advertising or tracking hosts.`
    )
  }

  const redirectCount = Math.max(0, hops.length - 1)
  if (redirectCount >= NOTABLE_HOP_COUNT) {
    reasons.push(`${redirectCount} redirects before arriving at the final page.`)
  }
  if (domains.length >= 3) {
    reasons.push(`Passed through ${domains.length} different domains: ${domains.join(' → ')}.`)
  }

  const first = hops[0]
  const last = hops[hops.length - 1]
  if (first && last && domainOf(first.host) !== domainOf(last.host) && redirectCount > 0) {
    reasons.push(
      `Started on ${domainOf(first.host)} and finished on ${domainOf(last.host)}.`
    )
  }

  if (adHops.length > 0) return { verdict: 'suspicious', reasons, domains }
  if (reasons.length > 0) return { verdict: 'notable', reasons, domains }

  return {
    verdict: 'ordinary',
    reasons:
      redirectCount === 0
        ? ['No redirects — the address you asked for is the page you got.']
        : [`${redirectCount} redirect${redirectCount === 1 ? '' : 's'} within ${domains.join(', ')}.`],
    domains
  }
}

/** Whether a chain is worth surfacing to the user unprompted. */
export function isWorthReporting(verdict: ChainVerdict): boolean {
  return verdict === 'suspicious' || verdict === 'notable'
}
