import { z } from 'zod'

/**
 * Redirect X-Ray.
 *
 * Records where a navigation actually went on its way to where it ended up, and
 * shows the whole chain. A redirect through four hosts you have never heard of is
 * ordinary on the modern web and is also how tracking and misdirection work —
 * the browser cannot always tell which, but it can show the route and let the
 * user decide.
 *
 * **The overriding constraint is not breaking sign-in.** OAuth, SSO, 3-D Secure
 * and payment gateways are all multi-hop cross-domain redirect chains, and they
 * look structurally identical to the abusive kind. Flagging them would train the
 * user to dismiss the warning at exactly the moment it matters, so recognised
 * authentication flows are classified as such and never reported as suspicious.
 */

export const RedirectKindSchema = z.enum([
  /** Permanent — 301/308. */
  'permanent',
  /** Temporary — 302/303/307. */
  'temporary',
  /** Client-side: meta refresh, or a script assigning location. */
  'client',
  /** Observed a hop but not how it happened. */
  'unknown'
])
export type RedirectKind = z.infer<typeof RedirectKindSchema>

export const RedirectHopSchema = z.object({
  url: z.string(),
  host: z.string(),
  kind: RedirectKindSchema,
  /** HTTP status where one was observed, else null. */
  statusCode: z.number().int().nullable(),
  at: z.number()
})
export type RedirectHop = z.infer<typeof RedirectHopSchema>

export const ChainVerdictSchema = z.enum([
  /** One or two hops within a site. Nothing to say. */
  'ordinary',
  /**
   * A recognised sign-in or payment flow.
   *
   * Reported as its own verdict rather than as "ordinary" so the panel can
   * explain *why* a five-host chain is expected here.
   */
  'authentication',
  /** Worth looking at: many hops, or several unrelated domains. */
  'notable',
  /** Passed through a known advertising or tracking host on the way. */
  'suspicious'
])
export type ChainVerdict = z.infer<typeof ChainVerdictSchema>

export const RedirectChainSchema = z.object({
  id: z.string(),
  tabId: z.string(),
  /** Where the navigation began. The "Return to original page" target. */
  originalUrl: z.string(),
  finalUrl: z.string(),
  hops: z.array(RedirectHopSchema),
  verdict: ChainVerdictSchema,
  /** Why this verdict, most significant first. Always populated. */
  reasons: z.array(z.string()),
  /** Distinct registrable domains crossed, in order first seen. */
  domains: z.array(z.string()),
  startedAt: z.number(),
  /** Null while the navigation is still resolving. */
  completedAt: z.number().nullable()
})
export type RedirectChain = z.infer<typeof RedirectChainSchema>

/** Chains kept per window. Older ones are dropped. */
export const REDIRECT_CHAIN_LIMIT = 40

/** Hops beyond this count are worth showing the user regardless of destination. */
export const NOTABLE_HOP_COUNT = 4
