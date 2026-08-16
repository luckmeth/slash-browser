import type { ProtectionMode } from '@shared/types/shield'

/**
 * Watches top-level navigation for the patterns abusive pages use, without
 * getting in the way of the ones legitimate sites depend on.
 *
 * The asymmetry that shapes this file: a missed ad redirect is an annoyance, a
 * blocked sign-in redirect is a browser that does not work. Sign-in, payment and
 * bot-check flows are *deliberately* long chains of fast cross-site hops with no
 * click in between — exactly the shape this is looking for — so they are
 * exempted by name before any heuristic runs.
 *
 * Pure and clock-injected. It records navigation metadata only: host, time,
 * whether a gesture preceded it. Never the URL, never page content.
 */

/**
 * Hosts whose redirect behaviour is never treated as suspicious.
 *
 * Identity providers, payment processors and bot checks. This list existing is
 * an admission that the heuristics below cannot tell a hostile redirect chain
 * from an OAuth dance on shape alone — so for the flows where being wrong is
 * most expensive, shape is not consulted at all.
 */
const NEVER_SUSPICIOUS: readonly string[] = [
  // Identity
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'github.com',
  'gitlab.com',
  'okta.com',
  'auth0.com',
  'onelogin.com',
  'duosecurity.com',
  'facebook.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  // Payment
  'paypal.com',
  'stripe.com',
  'checkout.stripe.com',
  'adyen.com',
  'braintreegateway.com',
  'squareup.com',
  'klarna.com',
  'checkout.com',
  '3dsecure.io',
  // Bot checks
  'recaptcha.net',
  'hcaptcha.com',
  'challenges.cloudflare.com',
  'arkoselabs.com'
]

/** A chain of this many hops in the window below, unclicked, is a redirect loop. */
const RAPID_CHAIN_HOPS = 3
const RAPID_CHAIN_WINDOW_MS = 2500

/** How long a gesture keeps vouching for the navigations that follow it. */
const GESTURE_VOUCH_MS = 2000

export interface NavigationHop {
  readonly host: string
  readonly at: number
  /** Milliseconds between the last trusted gesture and this hop, or null. */
  readonly msSinceGesture: number | null
}

export interface RedirectFacts {
  /** Most recent first is *not* assumed; this is in chronological order. */
  readonly chain: readonly NavigationHop[]
  readonly mode: ProtectionMode
  /** The destination is a known advertising or tracking host. */
  readonly targetIsKnownAd: boolean
  readonly siteLocked: boolean
  readonly isCrossSite: boolean
}

export type RedirectReason =
  | 'exempt-known-flow'
  | 'user-initiated'
  | 'ordinary-navigation'
  | 'rapid-unclicked-chain'
  | 'ad-destination'
  | 'site-locked'
  | 'cross-site-unclicked-strict'

export interface RedirectVerdict {
  readonly action: 'allow' | 'block' | 'warn'
  readonly reason: RedirectReason
}

export function explainRedirect(reason: RedirectReason): string {
  switch (reason) {
    case 'exempt-known-flow':
      return 'This is a sign-in, payment or security check, which Slash never interferes with.'
    case 'user-initiated':
      return 'You clicked something that led here.'
    case 'ordinary-navigation':
      return 'Normal navigation.'
    case 'rapid-unclicked-chain':
      return 'This page bounced through several sites in under a second without you clicking anything.'
    case 'ad-destination':
      return 'This page tried to send you to a known advertising site on its own.'
    case 'site-locked':
      return 'Stay on This Site is on for this tab.'
    case 'cross-site-unclicked-strict':
      return 'Strict mode blocks jumps to other sites that you did not ask for.'
  }
}

/** Whether a host is one of the flows that are never judged on shape. */
export function isExemptHost(host: string): boolean {
  const clean = host.trim().toLowerCase().replace(/^www\./, '')
  return NEVER_SUSPICIOUS.some((exempt) => clean === exempt || clean.endsWith(`.${exempt}`))
}

/**
 * Judges a pending top-level navigation.
 *
 * Returns `warn` rather than `block` where the evidence is a pattern rather than
 * a rule: the product principle is that we never call a navigation malicious
 * without a rule or a reputation source saying so, and "this looked fast" is
 * neither.
 */
export function decideRedirect(facts: RedirectFacts): RedirectVerdict {
  const target = facts.chain[facts.chain.length - 1]
  if (!target) return { action: 'allow', reason: 'ordinary-navigation' }

  // Exemptions first, before anything can form an opinion.
  if (isExemptHost(target.host)) {
    return { action: 'allow', reason: 'exempt-known-flow' }
  }
  const previous = facts.chain[facts.chain.length - 2]
  if (previous && isExemptHost(previous.host)) {
    // Coming *back* from an identity provider is the other half of the flow.
    return { action: 'allow', reason: 'exempt-known-flow' }
  }

  // A destination on the ad lists, reached without a click, is the one case with
  // an actual rule behind it — so it is the one case that blocks outright.
  const clicked = target.msSinceGesture !== null && target.msSinceGesture <= GESTURE_VOUCH_MS
  if (facts.targetIsKnownAd && !clicked) {
    return { action: 'block', reason: 'ad-destination' }
  }

  if (facts.siteLocked && facts.isCrossSite && !clicked) {
    return { action: 'block', reason: 'site-locked' }
  }

  if (clicked) {
    return { action: 'allow', reason: 'user-initiated' }
  }

  if (isRapidChain(facts.chain)) {
    return { action: 'warn', reason: 'rapid-unclicked-chain' }
  }

  if (facts.mode === 'strict' && facts.isCrossSite) {
    return { action: 'warn', reason: 'cross-site-unclicked-strict' }
  }

  return { action: 'allow', reason: 'ordinary-navigation' }
}

/**
 * Whether the tail of the chain is several unclicked hops in quick succession.
 *
 * Counts only *distinct* hosts: a page rewriting its own URL repeatedly is a
 * single-page app doing routing, not a redirect chain, and treating it as one
 * would flag ordinary sites constantly.
 */
function isRapidChain(chain: readonly NavigationHop[]): boolean {
  const tail = chain.slice(-RAPID_CHAIN_HOPS)
  if (tail.length < RAPID_CHAIN_HOPS) return false

  const first = tail[0]
  const last = tail[tail.length - 1]
  if (!first || !last) return false
  if (last.at - first.at > RAPID_CHAIN_WINDOW_MS) return false

  const unclicked = tail.every((hop) => hop.msSinceGesture === null || hop.msSinceGesture > GESTURE_VOUCH_MS)
  if (!unclicked) return false

  return new Set(tail.map((hop) => hop.host)).size === RAPID_CHAIN_HOPS
}

/** Trims a chain to what the monitor needs, so it cannot grow without bound. */
export function trimChain(chain: readonly NavigationHop[]): NavigationHop[] {
  return chain.slice(-RAPID_CHAIN_HOPS * 2)
}
