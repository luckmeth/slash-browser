import type { CampaignInput, Rate } from './types/advertising'
import { CREATIVE_TYPES, MAX_CREATIVE_BYTES } from './types/advertising'

/**
 * Whether a campaign may be submitted, and what it will cost.
 *
 * The cost here is an **estimate shown while somebody drags the dates**. The
 * database applies the real price with a trigger from `pricing_config`, and
 * that is deliberate: a price arriving from a browser is a price somebody can
 * edit. The two agreeing is not an accident either — it is what the tests in
 * this file are for, because a screen that quotes one figure and a checkout
 * that charges another is worse than no quote at all.
 *
 * Pure and clock-injected so the lead-time rule can be tested without waiting
 * until tomorrow.
 */

export interface CampaignProblem {
  field: keyof CampaignInput | 'image'
  problem: string
}

export interface CampaignCost {
  hours: number
  hourlyRate: number
  total: number
}

/** Hours between two form values, or 0 when either cannot be read. */
export function hoursBetween(startsAt: string, endsAt: string): number {
  const start = Date.parse(startsAt)
  const end = Date.parse(endsAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  return (end - start) / 3_600_000
}

/**
 * What the run will cost at the rate on the card.
 *
 * Rounded to whole cents the same way money is handled everywhere else here:
 * a fraction of a cent quoted on screen and dropped at checkout is exactly the
 * kind of drift this mirrors the trigger to avoid.
 */
export function estimateCost(input: CampaignInput, rates: readonly Rate[]): CampaignCost {
  const rate = rates.find((entry) => entry.placementTier === input.placementTier)
  const hours = hoursBetween(input.startsAt, input.endsAt)
  if (!rate) return { hours, hourlyRate: 0, total: 0 }
  return {
    hours,
    hourlyRate: rate.hourlyRate,
    total: Math.round(hours * rate.hourlyRate * 100) / 100
  }
}

/**
 * Every problem with a campaign, in field order.
 *
 * All of them at once: a form that reveals one mistake per submission is a
 * form people abandon, and this one asks for six things and a picture.
 */
export function checkCampaign(
  input: CampaignInput,
  rates: readonly Rate[],
  minLeadHours: number,
  now: number
): CampaignProblem[] {
  const problems: CampaignProblem[] = []

  const title = input.title.trim()
  if (title === '') problems.push({ field: 'title', problem: 'A title is needed.' })
  else if (title.length > 200) problems.push({ field: 'title', problem: 'That title is too long.' })

  if (input.description.length > 400) {
    problems.push({ field: 'description', problem: 'The description is limited to 400 characters.' })
  }

  const link = input.destinationLink.trim()
  if (link === '') {
    problems.push({ field: 'destinationLink', problem: 'Where should the advert send people?' })
  } else if (!/^https:\/\//i.test(link)) {
    // The same rule the browser applies to a publisher notice: a link put in
    // front of every reader is https, or it is not shown.
    problems.push({
      field: 'destinationLink',
      problem: 'The link has to start with https:// — an advert is put in front of readers.'
    })
  }

  const rate = rates.find((entry) => entry.placementTier === input.placementTier)
  if (!rate) {
    problems.push({ field: 'placementTier', problem: 'Choose a placement.' })
  }

  const start = Date.parse(input.startsAt)
  const hours = hoursBetween(input.startsAt, input.endsAt)

  if (!Number.isFinite(start)) {
    problems.push({ field: 'startsAt', problem: 'A start date is needed.' })
  } else if (start < now + minLeadHours * 3_600_000) {
    // Not a formality: batches are collected every six hours, so a campaign
    // starting sooner than the lead time may simply never reach the readers it
    // was sold to.
    problems.push({
      field: 'startsAt',
      problem: `Campaigns start at least ${minLeadHours} hours from now, because browsers collect adverts a few times a day.`
    })
  }

  if (hours <= 0) {
    problems.push({ field: 'endsAt', problem: 'The end has to be after the start.' })
  } else if (hours !== Math.trunc(hours)) {
    // The pricing trigger refuses a fractional hour outright, and it is right
    // to: an advert is sold by the hour and a bill for 12.4 of them is an
    // argument waiting to happen. Checked here so it is a sentence beside the
    // field rather than a rejection after pressing submit.
    problems.push({
      field: 'endsAt',
      problem: `Campaigns run for a whole number of hours — this is ${hours.toFixed(2)}. Set the same minutes past the hour at both ends.`
    })
  } else if (rate && hours < rate.minHours) {
    problems.push({
      field: 'endsAt',
      problem: `${rate.displayName} is sold in blocks of at least ${rate.minHours} hours.`
    })
  }

  if (input.imageBase64 !== '') {
    if (!CREATIVE_TYPES.includes(input.imageType as (typeof CREATIVE_TYPES)[number])) {
      problems.push({ field: 'image', problem: 'The creative has to be a PNG, JPEG or WebP.' })
    }
    // base64 is 4 characters per 3 bytes; this is the size the bucket will see.
    const bytes = Math.floor((input.imageBase64.length * 3) / 4)
    if (bytes > MAX_CREATIVE_BYTES) {
      problems.push({
        field: 'image',
        problem: `That image is ${Math.round(bytes / 1024)} KB. The limit is ${Math.round(
          MAX_CREATIVE_BYTES / 1024
        )} KB, because every live creative ships inside the batch each reader downloads.`
      })
    }
  }

  return problems
}
