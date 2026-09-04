import { z } from 'zod'

/**
 * Advertising, from inside the browser.
 *
 * A company signs in with the same Google account it browses with, fills in
 * who it is, and submits a campaign — without leaving Slash and without a
 * second account. The portal at the other end still exists and does the same
 * things; this is the same database, reached directly.
 *
 * Two boundaries this deliberately keeps.
 *
 * **The price is not decided here.** `estimateCost` exists so the figure moves
 * as somebody drags the dates, and the database applies the real one with a
 * trigger from `pricing_config`. A price that arrives from a browser is a
 * price somebody can edit, and the two agreeing is what the estimator is
 * tested against.
 *
 * **Payment is not done here.** Taking a card means Stripe, and Stripe means a
 * web checkout with its own domain and its own 3-D Secure flow. That opens in
 * a tab, as it would anywhere else. Pretending otherwise would mean handling
 * card details inside an Electron renderer, which this project will not do.
 */

export const PLACEMENTS = ['home_banner', 'newtab_feature'] as const

export const RateSchema = z.object({
  placementTier: z.string(),
  displayName: z.string(),
  description: z.string().default(''),
  hourlyRate: z.number(),
  minHours: z.number(),
  maxConcurrent: z.number()
})
export type Rate = z.infer<typeof RateSchema>

export const CompanyProfileSchema = z.object({
  id: z.string().default(''),
  companyName: z.string().default(''),
  contactEmail: z.string().default(''),
  website: z.string().default(''),
  description: z.string().default(''),
  contactName: z.string().default(''),
  contactPhone: z.string().default(''),
  addressLine1: z.string().default(''),
  city: z.string().default(''),
  postcode: z.string().default(''),
  country: z.string().default(''),
  taxId: z.string().default(''),
  /** 'active' or 'suspended'. Set by an operator, never here. */
  status: z.string().default('active'),
  complete: z.boolean().default(false)
})
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>

/** The subset of a company profile an advertiser may write from the browser. */
export const CompanyInputSchema = CompanyProfileSchema.pick({
  companyName: true,
  contactEmail: true,
  website: true,
  description: true,
  contactName: true,
  contactPhone: true,
  addressLine1: true,
  city: true,
  postcode: true,
  country: true,
  taxId: true
})
export type CompanyInput = z.infer<typeof CompanyInputSchema>

export const CampaignInputSchema = z.object({
  title: z.string().max(200),
  description: z.string().max(400).default(''),
  destinationLink: z.string().max(400),
  placementTier: z.string(),
  /** `YYYY-MM-DDTHH:mm`, local, from the form. */
  startsAt: z.string(),
  endsAt: z.string(),
  /**
   * The creative, as bytes.
   *
   * Sent over IPC as base64 because the bucket caps a creative at 512 KB — the
   * batch carries every live image inline, so the size of an advert is a
   * download every reader takes. Empty means no image was chosen.
   */
  imageBase64: z.string().default(''),
  imageType: z.string().default('')
})
export type CampaignInput = z.infer<typeof CampaignInputSchema>

export const CampaignSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  placementTier: z.string(),
  totalCost: z.number(),
  totalHours: z.number(),
  startsAt: z.string(),
  endsAt: z.string(),
  reviewNote: z.string().default(''),
  /**
   * What was delivered, summed from the daily counts.
   *
   * Indicative and late by design: browsers report in batches every few hours
   * and only when they are reopened, so a campaign that started an hour ago
   * shows nothing and that is correct rather than broken. The screen says so
   * rather than letting somebody conclude their advert is not running.
   */
  impressions: z.number().default(0),
  clicks: z.number().default(0),
  /** Whether the advertiser may still take it back: before review or payment. */
  cancellable: z.boolean().default(false)
})
export type CampaignSummary = z.infer<typeof CampaignSummarySchema>

export const AdvertiserStateSchema = z.object({
  /** The rewards sign-in doubles as the advertiser sign-in: one account. */
  signedIn: z.boolean(),
  email: z.string().default(''),
  company: CompanyProfileSchema.nullable().default(null),
  rates: z.array(RateSchema).default([]),
  campaigns: z.array(CampaignSummarySchema).default([]),
  /** Where to go to pay, when the portal address is configured. */
  portalUrl: z.string().default('')
})
export type AdvertiserState = z.infer<typeof AdvertiserStateSchema>

export const AdvertiserResultSchema = z.object({
  ok: z.boolean(),
  problem: z.string().default(''),
  /** The campaign that was created, when one was. */
  campaignId: z.string().default('')
})
export type AdvertiserResult = z.infer<typeof AdvertiserResultSchema>

/** 512 KB, the bucket's own limit, stated where the picker can enforce it. */
export const MAX_CREATIVE_BYTES = 524_288
export const CREATIVE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
