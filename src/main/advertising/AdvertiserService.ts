import { net } from 'electron'
import {
  AdvertiserStateSchema,
  CampaignSummarySchema,
  CompanyProfileSchema,
  RateSchema,
  type AdvertiserResult,
  type AdvertiserState,
  type CampaignInput,
  type CompanyInput,
  type Rate
} from '@shared/types/advertising'
import { checkCampaign } from '@shared/campaignRules'
import { REWARDS_ANON_KEY_DEFAULT, REWARDS_URL_DEFAULT } from '@shared/types/rewards'
import type { SettingsStore } from '../settings/SettingsStore'
import type { RewardsService } from '../rewards/RewardsService'
import { createLogger } from '../logger'

const log = createLogger('advertising')

/**
 * Submitting a campaign without leaving the browser.
 *
 * The same database the portal writes to, reached directly with the session
 * the reader already has: signing in to Slash Coin and signing in to advertise
 * are one account, because they are one Google account and one `auth.users`
 * row. There is no second sign-up.
 *
 * What makes this safe to do from a renderer-driven flow is that **none of the
 * decisions are here**. Row-level security restricts `advertisers` to the
 * caller's own row and `campaigns` to their own campaigns; a trigger sets the
 * price from `pricing_config`, so the figure this browser shows is an estimate
 * and never an input; `status` is refused by policy, so a submitted campaign
 * cannot arrive already approved. This class assembles requests. The database
 * decides.
 *
 * Payment is deliberately not here: it means Stripe, and Stripe means a web
 * checkout with its own domain and 3-D Secure. That opens in a tab, as it
 * would anywhere else — handling card details inside an Electron renderer is
 * not a thing this project does.
 */
export class AdvertiserService {
  constructor(
    private readonly rewards: RewardsService,
    private readonly settings: SettingsStore
  ) {}

  private get baseUrl(): string {
    const override = this.settings.getAll().rewardsEndpoint.trim()
    return (override === '' ? REWARDS_URL_DEFAULT : override).replace(/\/+$/, '')
  }

  /**
   * A REST call as the signed-in person.
   *
   * The anon key identifies the project; the bearer token is the session. Both
   * are required by PostgREST, and it is the token that decides what comes
   * back — which is why every read below can safely say `select=*` and trust
   * the policy rather than filtering by a user id this process would have to
   * be right about.
   */
  private async rest(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.rewards.token()
    if (token === '') throw new Error('not signed in')

    return await net.fetch(`${this.baseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: REWARDS_ANON_KEY_DEFAULT,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {})
      }
    })
  }

  /** Everything the advertise screen needs, in one call. */
  async state(): Promise<AdvertiserState> {
    const portalUrl = this.settings.getAll().advertisePortalUrl.trim()

    if (!this.rewards.signedIn) {
      return AdvertiserStateSchema.parse({ signedIn: false, portalUrl })
    }

    const [company, rates, campaigns] = await Promise.all([
      this.company(),
      this.rates(),
      this.campaigns()
    ])

    return AdvertiserStateSchema.parse({
      signedIn: true,
      email: this.rewards.email,
      company,
      rates,
      campaigns,
      portalUrl
    })
  }

  /**
   * The caller's own advertiser row.
   *
   * No filter on the request: the policy is `auth_user_id = auth.uid()`, so
   * asking for every row returns exactly one — theirs — and a filter written
   * here could only ever be a second, weaker copy of that rule.
   */
  private async company(): Promise<AdvertiserState['company']> {
    try {
      const response = await this.rest('advertisers?select=*&limit=1')
      if (!response.ok) return null
      const rows = (await response.json()) as Record<string, unknown>[]
      const row = rows[0]
      if (!row) return null

      return CompanyProfileSchema.parse({
        id: String(row.id ?? ''),
        companyName: String(row.company_name ?? ''),
        contactEmail: String(row.contact_email ?? ''),
        website: String(row.website ?? ''),
        description: String(row.description ?? ''),
        contactName: String(row.contact_name ?? ''),
        contactPhone: String(row.contact_phone ?? ''),
        addressLine1: String(row.address_line1 ?? ''),
        city: String(row.city ?? ''),
        postcode: String(row.postcode ?? ''),
        country: String(row.country ?? ''),
        taxId: String(row.tax_id ?? ''),
        status: String(row.status ?? 'active'),
        complete: row.profile_updated_at !== null && row.profile_updated_at !== undefined
      })
    } catch (error) {
      log.warn(`could not read the company profile: ${String(error)}`)
      return null
    }
  }

  /** The rate card. Readable signed out too, which is why prices are on the page. */
  private async rates(): Promise<Rate[]> {
    try {
      const response = await this.rest(
        'pricing_config?select=placement_tier,display_name,description,hourly_rate,min_hours,max_concurrent&active=eq.true&order=hourly_rate.asc'
      )
      if (!response.ok) return []
      const rows = (await response.json()) as Record<string, unknown>[]
      return rows.map((row) =>
        RateSchema.parse({
          placementTier: String(row.placement_tier ?? ''),
          displayName: String(row.display_name ?? ''),
          description: String(row.description ?? ''),
          hourlyRate: Number(row.hourly_rate ?? 0),
          minHours: Number(row.min_hours ?? 24),
          maxConcurrent: Number(row.max_concurrent ?? 1)
        })
      )
    } catch (error) {
      log.warn(`could not read the rate card: ${String(error)}`)
      return []
    }
  }

  private async campaigns(): Promise<AdvertiserState['campaigns']> {
    try {
      // The delivery counts come back nested rather than as a second request:
      // one round trip, and the numbers cannot belong to a different campaign
      // than the row they are printed under.
      const response = await this.rest(
        'campaigns?select=id,title,status,placement_tier,total_cost,total_hours,starts_at,ends_at,review_note,delivery_counts(impressions,clicks)&order=created_at.desc&limit=50'
      )
      if (!response.ok) return []
      const rows = (await response.json()) as Record<string, unknown>[]

      return rows.map((row) => {
        const counts = Array.isArray(row.delivery_counts)
          ? (row.delivery_counts as { impressions?: number; clicks?: number }[])
          : []
        const status = String(row.status ?? '')

        return CampaignSummarySchema.parse({
          id: String(row.id ?? ''),
          title: String(row.title ?? ''),
          status,
          placementTier: String(row.placement_tier ?? ''),
          totalCost: Number(row.total_cost ?? 0),
          totalHours: Number(row.total_hours ?? 0),
          startsAt: String(row.starts_at ?? ''),
          endsAt: String(row.ends_at ?? ''),
          reviewNote: String(row.review_note ?? ''),
          impressions: counts.reduce((sum, day) => sum + Number(day.impressions ?? 0), 0),
          clicks: counts.reduce((sum, day) => sum + Number(day.clicks ?? 0), 0),
          // The same two statuses the delete policy allows. Stated here so the
          // button appears exactly when the database would accept it, rather
          // than being offered and then refused.
          cancellable: status === 'pending_review' || status === 'pending_payment'
        })
      })
    } catch (error) {
      log.warn(`could not read campaigns: ${String(error)}`)
      return []
    }
  }

  /**
   * Takes a campaign back before anybody has acted on it.
   *
   * A delete rather than a status change, because that is what the policy
   * allows: `campaigns_delete_before_review` permits it while the row is
   * waiting for review or for payment, and nothing after that. A campaign that
   * has been approved or has run is history, and history is not deleted from
   * the advertiser side.
   */
  async cancelCampaign(id: string): Promise<AdvertiserResult> {
    if (!this.rewards.signedIn) return { ok: false, problem: 'Sign in first.', campaignId: '' }

    try {
      const response = await this.rest(`campaigns?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE'
      })
      if (!response.ok) {
        const detail = await response.text()
        log.warn(`campaign cancel failed: ${response.status} ${detail}`)
        return { ok: false, problem: readablePostgrest(detail, response.status), campaignId: '' }
      }
      return { ok: true, problem: '', campaignId: id }
    } catch (error) {
      return { ok: false, problem: String(error), campaignId: '' }
    }
  }

  /** Creates or updates the company profile. */
  async saveCompany(input: CompanyInput): Promise<AdvertiserResult> {
    if (!this.rewards.signedIn) return { ok: false, problem: 'Sign in first.', campaignId: '' }

    const name = input.companyName.trim()
    if (name === '') {
      return { ok: false, problem: 'A company name is needed — it is what readers see.', campaignId: '' }
    }
    const email = input.contactEmail.trim()
    if (!email.includes('@')) {
      return { ok: false, problem: 'A contact email is needed.', campaignId: '' }
    }
    const website = input.website.trim()
    if (website !== '' && !/^https:\/\//i.test(website)) {
      return { ok: false, problem: 'The website has to start with https://.', campaignId: '' }
    }

    // A function, not a PATCH, for two reasons found by trying the PATCH.
    //
    // Supabase runs the `safeupdate` extension, so an UPDATE with no filter is
    // refused outright — `400 UPDATE requires a WHERE clause` — and the request
    // deliberately had no filter, because row-level security already scopes it
    // to the caller and a filter here would be a second, weaker copy of that.
    //
    // And there was nothing to update: `mark_browser_account()` deletes the
    // advertiser row the signup trigger creates whenever it is untouched, so
    // every browser account has none. The function upserts, keyed to the
    // session, and touches only the columns an advertiser owns.
    const details = {
      companyName: name,
      contactEmail: email,
      website,
      description: input.description.trim().slice(0, 600),
      contactName: input.contactName.trim().slice(0, 120),
      contactPhone: input.contactPhone.trim().slice(0, 32),
      addressLine1: input.addressLine1.trim().slice(0, 160),
      city: input.city.trim().slice(0, 80),
      postcode: input.postcode.trim().slice(0, 24),
      country: input.country.trim().toUpperCase().slice(0, 2),
      taxId: input.taxId.trim().slice(0, 40)
    }

    try {
      const response = await this.rest('rpc/save_advertiser_profile', {
        method: 'POST',
        body: JSON.stringify({ details })
      })
      if (!response.ok) {
        const detail = await response.text()
        log.warn(`company save failed: ${response.status} ${detail}`)
        return { ok: false, problem: readablePostgrest(detail, response.status), campaignId: '' }
      }
      return { ok: true, problem: '', campaignId: '' }
    } catch (error) {
      return { ok: false, problem: String(error), campaignId: '' }
    }
  }

  /**
   * Uploads the creative and creates the campaign.
   *
   * In that order, and not in a transaction, because there is no transaction
   * that spans object storage and a table. An upload with no campaign after it
   * is an orphaned file in the advertiser's own folder; a campaign with no
   * image would be an advert with nothing to show. The recoverable failure is
   * the one left possible.
   */
  async submitCampaign(input: CampaignInput): Promise<AdvertiserResult> {
    if (!this.rewards.signedIn) return { ok: false, problem: 'Sign in first.', campaignId: '' }

    const company = await this.company()
    if (!company || company.id === '') {
      return { ok: false, problem: 'Fill in your company details first.', campaignId: '' }
    }
    if (company.status !== 'active') {
      return { ok: false, problem: 'This advertiser account is suspended.', campaignId: '' }
    }

    const rates = await this.rates()
    const minLead = 12
    const problems = checkCampaign(input, rates, minLead, Date.now())
    if (problems.length > 0) {
      return { ok: false, problem: problems[0]!.problem, campaignId: '' }
    }

    let imagePath = ''
    if (input.imageBase64 !== '') {
      const uploaded = await this.uploadCreative(input)
      if (!uploaded.ok) return uploaded
      imagePath = uploaded.problem // carries the path on success; see below
    }

    try {
      const response = await this.rest('campaigns', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({
          advertiser_id: company.id,
          title: input.title.trim(),
          description: input.description.trim(),
          destination_link: input.destinationLink.trim(),
          placement_tier: input.placementTier,
          image_path: imagePath === '' ? null : imagePath,
          starts_at: new Date(input.startsAt).toISOString(),
          ends_at: new Date(input.endsAt).toISOString()
          // `status` is deliberately absent, and sending it was what made every
          // submission fail with "permission denied". The insert grant on this
          // table is **per column** -- eight of them, and `status` is not one,
          // because a client that can state its own status is a client that can
          // approve its own campaign. The column defaults to `pending_review`,
          // which is exactly what a submission is.
          //
          // The money columns are absent for the same reason: the pricing
          // trigger computes them and ignores anything a client claims.
        })
      })

      if (!response.ok) {
        const detail = await response.text()
        log.warn(`campaign submit failed: ${response.status} ${detail}`)
        return { ok: false, problem: readablePostgrest(detail, response.status), campaignId: '' }
      }

      const rows = (await response.json()) as Record<string, unknown>[]
      const id = String(rows[0]?.id ?? '')
      log.info(`campaign submitted: ${id}`)
      return { ok: true, problem: '', campaignId: id }
    } catch (error) {
      return { ok: false, problem: String(error), campaignId: '' }
    }
  }

  /**
   * Puts the creative in the advertiser's own folder.
   *
   * The folder is named for their auth id and the storage policy checks that
   * prefix, so an upload cannot land anywhere else — without it, any signed-in
   * advertiser could overwrite another's artwork, including one already live.
   * The path is returned in `problem` on success, which is ugly and keeps the
   * result shape single; the caller reads it only after checking `ok`.
   */
  private async uploadCreative(input: CampaignInput): Promise<AdvertiserResult> {
    const uid = this.rewards.userId
    if (uid === '') return { ok: false, problem: 'Sign in first.', campaignId: '' }

    const extension =
      input.imageType === 'image/png' ? 'png' : input.imageType === 'image/webp' ? 'webp' : 'jpg'
    const path = `${uid}/${Date.now()}.${extension}`
    const bytes = Buffer.from(input.imageBase64, 'base64')

    try {
      const token = await this.rewards.token()
      const response = await net.fetch(`${this.baseUrl}/storage/v1/object/campaign-assets/${path}`, {
        method: 'POST',
        headers: {
          apikey: REWARDS_ANON_KEY_DEFAULT,
          authorization: `Bearer ${token}`,
          'content-type': input.imageType,
          'cache-control': '3600'
        },
        body: bytes
      })

      if (!response.ok) {
        const detail = await response.text()
        log.warn(`creative upload failed: ${response.status} ${detail}`)
        return {
          ok: false,
          problem: `The image could not be uploaded (${response.status}). ${
            response.status === 413 ? 'It is over the 512 KB limit.' : ''
          }`,
          campaignId: ''
        }
      }

      return { ok: true, problem: path, campaignId: '' }
    } catch (error) {
      return { ok: false, problem: String(error), campaignId: '' }
    }
  }
}

/**
 * A PostgREST error as a sentence.
 *
 * The raw body names constraints and columns, which is right for a log and
 * useless in front of somebody who has just filled in a form. The few that a
 * correct client can still hit are named; everything else keeps the code.
 */
function readablePostgrest(body: string, status: number): string {
  // The pricing trigger raises these, and they are the rules a person is most
  // likely to hit. Passed through nearly verbatim: they already name the
  // number that is wrong, which is more use than anything this could add.
  if (/whole number of hours/.test(body)) {
    return 'Campaigns run for a whole number of hours — set the start and end to the same minute.'
  }
  if (/sold in blocks of at least/.test(body)) {
    const match = /at least (\d+) hours/.exec(body)
    return `That placement is sold in blocks of at least ${match?.[1] ?? 'more'} hours.`
  }
  if (/is not on sale/.test(body)) return 'That placement is not on sale at the moment.'
  if (/unknown placement tier/.test(body)) return 'That placement no longer exists — pick another.'
  if (/null value in column "advertiser_id"/.test(body)) {
    return 'Your company profile could not be found. Save it again and retry.'
  }
  // The function raises these deliberately, with the field in the message.
  if (/company name is needed/i.test(body)) return 'A company name is needed.'
  if (/website has to start/i.test(body)) return 'The website has to start with https://.'
  if (/save_advertiser_profile|PGRST202|Could not find the function/i.test(body)) {
    return 'This deployment is missing save_advertiser_profile. Apply supabase/migrations/20260904_advertiser_profile.sql.'
  }
  if (/destination_link/.test(body)) return 'The destination link has to start with https://.'
  if (/campaign_window_ordered/.test(body)) return 'The end has to be after the start.'
  if (/row-level security|permission denied/i.test(body)) {
    return 'That was refused by the server. If your account was suspended, the operator can say why.'
  }
  if (status === 401 || status === 403) return 'Your sign-in has expired. Sign in again.'
  return `The server refused it (${status}).`
}
