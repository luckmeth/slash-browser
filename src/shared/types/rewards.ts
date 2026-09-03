import { z } from 'zod'

/**
 * Slash Coin: a pre-launch rewards balance.
 *
 * Two things this deliberately is not.
 *
 * **It is not money, and the wording never implies it is.** These are points
 * with no cash value and no promised conversion. Granting future value in
 * exchange for present activity is the structure regulators look at hardest,
 * so nothing in the product says "worth", "$", or "exchange" until there is
 * advice saying it may.
 *
 * **It is not a balance the browser owns.** Everything here is a *copy* of what
 * the server last said. The browser reports intervals of qualifying time and
 * displays whatever comes back; it never computes a total and uploads it. A
 * balance the client owns is a balance a text editor can forge, which matters
 * the moment these are meant to become tradeable.
 */

/**
 * Where the rewards service lives.
 *
 * The anon key is public by design — it identifies the project, not the user,
 * and is the key every Supabase browser client ships. It grants nothing on its
 * own: the ledger is protected by row-level security, and the crediting
 * function is the only write path in. Both are verified by `supabase/coinProbe.py`,
 * which attacks this exact endpoint with a real signed token.
 */
export const REWARDS_URL_DEFAULT = 'https://edsuuwzihojdsmgzhzyw.supabase.co'
export const REWARDS_ANON_KEY_DEFAULT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkc3V1d3ppaG9qZHNtZ3poenl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MTcyNDcsImV4cCI6MjEwMjk5MzI0N30.AmssiF7U8jlIUNpjBy4-V7Z6jKnEbQAgCv6PLrJItL0'

export const RewardsStatusSchema = z.object({
  /** The user has switched Slash Coin on. Off on a fresh install. */
  enabled: z.boolean(),
  /** A secure store exists for the session token. Without one, no sign-in. */
  available: z.boolean(),
  signedIn: z.boolean(),
  email: z.string(),
  /** What the server last said. Never computed here. */
  balance: z.number(),
  /** Seconds banked today, from the server's own ledger. */
  secondsToday: z.number(),
  dailyCapSeconds: z.number(),
  /**
   * Indicative USD value of one coin, or **null when nobody has set it**.
   *
   * Null rather than zero, deliberately: zero is a rate, and rendering it
   * would tell somebody their coins are worth nothing rather than that the
   * figure has not been published. The screen shows "Pending" for null.
   */
  coinToUsd: z.number().nullable().default(null),
  /** When the pre-launch period ends; 0 when unset. */
  launchAt: z.number().default(0),
  /**
   * Whether the scheme is accruing at all, set by an operator.
   *
   * Defaults to **true**, so a browser that has not fetched yet -- or one
   * talking to a deployment that predates the switch -- never claims earning
   * has been stopped when nobody has stopped it. Distinct from `earning`,
   * which is about this moment on this machine.
   */
  earningActive: z.boolean().default(true),
  /**
   * The collector has given the details a payout would need, which is what
   * unlocks collecting. Defaults to **true** so a browser talking to a
   * deployment without the gate is not told it is locked out of a gate that
   * does not exist there.
   */
  profileComplete: z.boolean().default(true),
  coinsPerHour: z.number(),
  /** Epoch ms; 0 when the campaign end has not been fetched yet. */
  campaignEndsAt: z.number(),
  /**
   * A sign-in has been started and is still waiting for its code.
   *
   * Surfaced so the page can offer the manual finish *while it is relevant*,
   * rather than hiding it behind a disclosure somebody only opens after they
   * have already given up.
   */
  awaitingCode: z.boolean().default(false),
  /** Closed intervals on this machine the server has not accepted yet. */
  pending: z.number(),
  earning: z.boolean(),
  /** The sentence explaining why nothing is accruing, from `explain`. */
  note: z.string(),
  lastReportAt: z.number()
})

export type RewardsStatus = z.infer<typeof RewardsStatusSchema>

export const RewardsSignInResultSchema = z.object({
  ok: z.boolean(),
  problem: z.string(),
  /**
   * Where to send the user to sign in.
   *
   * Returned rather than opened by main, because it belongs in **a Slash tab**
   * — measured, not assumed: `SLASH_GOOGLE_UA_PROBE` loads Google's real
   * sign-in form in this browser with `blocked: false`, because Slash's user
   * agent carries no `Electron` token. Handing it to the operating system
   * instead was actively harmful: the flow then began in one browser and ended
   * in another, and a provider that cannot resolve its own flow state falls
   * back to its configured site address, which is the dead end people hit.
   *
   * Empty when the sign-in could not be started.
   */
  url: z.string().default('')
})

export type RewardsSignInResult = z.infer<typeof RewardsSignInResultSchema>

/** The wording used wherever a balance is shown. Deliberately one place. */
export const COIN_DISCLAIMER =
  'Slash Coin is a pre-launch reward with no cash value. It cannot be bought, sold or exchanged, and nothing here is a promise that it ever will be.'

/**
 * What a collector tells us about themselves, so a payout could reach them.
 *
 * Every field is typed by the person, and the email is deliberately **not**
 * here: it comes from the Google account that signed in, read server-side from
 * `auth.users`. A client that could set its own contact address could redirect
 * somebody else's payout notice.
 *
 * The rules live in `main/rewards/profileRules.ts` and the database repeats
 * the bounds as constraints, because a validator is a convenience and a
 * constraint is a guarantee.
 */
export const CoinProfileInputSchema = z.object({
  fullName: z.string().max(120).default(''),
  /** ISO date, `YYYY-MM-DD`, or empty when not answered. */
  dateOfBirth: z.string().max(10).default(''),
  addressLine1: z.string().max(160).default(''),
  addressLine2: z.string().max(160).default(''),
  city: z.string().max(80).default(''),
  region: z.string().max(80).default(''),
  postcode: z.string().max(24).default(''),
  /** ISO 3166-1 alpha-2. */
  country: z.string().max(2).default(''),
  phone: z.string().max(32).default(''),
  /** Where a payout would be sent. Storing it is not proof of control of it. */
  walletAddress: z.string().max(128).default(''),
  walletNetwork: z.string().max(24).default(''),
  /**
   * They would rather not hear from us beyond what the service has to send.
   *
   * Here rather than in a preference elsewhere because this is the form they
   * are already filling in, and a switch nobody can find is a switch that does
   * not exist. The operator broadcast in Slash Operations honours it.
   */
  emailOptOut: z.boolean().default(false)
})

export type CoinProfileInput = z.infer<typeof CoinProfileInputSchema>

export const CoinProfileSchema = CoinProfileInputSchema.extend({
  /** From the signed-in Google account, and not editable here. */
  email: z.string().default(''),
  /** Something has verified the wallet address. Nothing does yet. */
  walletVerified: z.boolean().default(false),
  /** Epoch ms of the last save; 0 when they have never saved one. */
  updatedAt: z.number().default(0),
  /** They have saved their details at least once. */
  complete: z.boolean().default(false)
})

export type CoinProfile = z.infer<typeof CoinProfileSchema>

export const CoinProfileResultSchema = z.object({
  ok: z.boolean(),
  /** Empty when it saved. One sentence per field that was refused otherwise. */
  problems: z.array(z.object({ field: z.string(), problem: z.string() })).default([]),
  profile: CoinProfileSchema.nullable().default(null)
})

export type CoinProfileResult = z.infer<typeof CoinProfileResultSchema>
