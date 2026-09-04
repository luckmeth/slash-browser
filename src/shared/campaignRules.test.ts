import { describe, expect, it } from 'vitest'
import { checkCampaign, estimateCost, hoursBetween } from './campaignRules'
import { MAX_CREATIVE_BYTES, type CampaignInput, type Rate } from './types/advertising'

const NOW = Date.parse('2026-09-03T12:00:00Z')

const RATES: Rate[] = [
  {
    placementTier: 'home_banner',
    displayName: 'Start page tile',
    description: '',
    hourlyRate: 2.5,
    minHours: 24,
    maxConcurrent: 6
  },
  {
    placementTier: 'newtab_feature',
    displayName: 'Featured placement',
    description: '',
    hourlyRate: 4,
    minHours: 24,
    maxConcurrent: 2
  }
]

const good: CampaignInput = {
  title: 'Autumn launch',
  description: 'Something worth reading.',
  destinationLink: 'https://example.com/autumn',
  placementTier: 'home_banner',
  startsAt: '2026-09-05T09:00:00Z',
  endsAt: '2026-09-08T09:00:00Z',
  imageBase64: '',
  imageType: ''
}

const fields = (input: Partial<CampaignInput>): string[] =>
  checkCampaign({ ...good, ...input }, RATES, 12, NOW).map((problem) => problem.field)

describe('a submittable campaign', () => {
  it('passes', () => {
    expect(checkCampaign(good, RATES, 12, NOW)).toEqual([])
  })

  it('reports every problem at once, not the first', () => {
    const found = fields({ title: '', destinationLink: '', endsAt: good.startsAt })
    expect(found).toEqual(['title', 'destinationLink', 'endsAt'])
  })
})

describe('the destination link', () => {
  it('must be https, because it is put in front of readers', () => {
    expect(fields({ destinationLink: 'http://example.com' })).toContain('destinationLink')
    expect(fields({ destinationLink: 'example.com' })).toContain('destinationLink')
    expect(fields({ destinationLink: 'HTTPS://example.com' })).toEqual([])
  })
})

describe('when a campaign may start', () => {
  it('honours the lead time, because batches are collected a few times a day', () => {
    // Two hours from now, against a twelve-hour lead time.
    expect(fields({ startsAt: '2026-09-03T14:00:00Z', endsAt: '2026-09-06T14:00:00Z' })).toContain(
      'startsAt'
    )
  })

  it('accepts a start exactly on the lead time', () => {
    expect(fields({ startsAt: '2026-09-04T00:00:00Z', endsAt: '2026-09-06T00:00:00Z' })).toEqual([])
  })

  it('refuses a window that ends before it starts', () => {
    expect(fields({ endsAt: '2026-09-04T09:00:00Z' })).toContain('endsAt')
  })

  it('refuses a part-hour run, which the pricing trigger will not price', () => {
    // The database raises "campaigns run for a whole number of hours"; this is
    // the same rule, said beside the field instead of after a refusal.
    const problems = checkCampaign(
      { ...good, startsAt: '2026-09-05T09:00:00Z', endsAt: '2026-09-08T09:30:00Z' },
      RATES,
      12,
      NOW
    )
    expect(problems.map((problem) => problem.field)).toContain('endsAt')
    expect(problems[0]?.problem).toContain('whole number of hours')
  })

  it('accepts a window that is whole hours at an odd minute', () => {
    // 09:17 to 09:17 three days later is 72 hours exactly, and legal.
    expect(fields({ startsAt: '2026-09-05T09:17:00Z', endsAt: '2026-09-08T09:17:00Z' })).toEqual([])
  })

  it('enforces the minimum block for the chosen placement', () => {
    // 12 hours, against a 24-hour minimum.
    expect(fields({ startsAt: '2026-09-05T09:00:00Z', endsAt: '2026-09-05T21:00:00Z' })).toContain(
      'endsAt'
    )
  })
})

describe('the creative', () => {
  const base64OfBytes = (count: number): string => 'A'.repeat(Math.ceil((count * 4) / 3))

  it('is optional', () => {
    expect(fields({ imageBase64: '', imageType: '' })).toEqual([])
  })

  it('must be an image format the bucket accepts', () => {
    expect(fields({ imageBase64: 'AAAA', imageType: 'image/gif' })).toContain('image')
    expect(fields({ imageBase64: 'AAAA', imageType: 'image/png' })).toEqual([])
  })

  it('is capped at the size every reader downloads', () => {
    // Every live creative ships inline in the batch, so this is not a storage
    // limit — it is the size of the download an advert costs each reader.
    const problems = checkCampaign(
      { ...good, imageBase64: base64OfBytes(MAX_CREATIVE_BYTES + 1024), imageType: 'image/png' },
      RATES,
      12,
      NOW
    )
    expect(problems.map((problem) => problem.field)).toContain('image')
    expect(problems[0]?.problem).toContain('KB')
  })
})

describe('the estimate, which must agree with the trigger', () => {
  it('is hours times the rate on the card', () => {
    // 72 hours at 2.50 = 180.00, which is what the database will charge.
    expect(estimateCost(good, RATES)).toEqual({ hours: 72, hourlyRate: 2.5, total: 180 })
  })

  it('follows the placement', () => {
    expect(estimateCost({ ...good, placementTier: 'newtab_feature' }, RATES).total).toBe(288)
  })

  it('rounds to whole cents rather than quoting a fraction of one', () => {
    const odd = { ...good, startsAt: '2026-09-05T09:00:00Z', endsAt: '2026-09-05T09:40:00Z' }
    expect(estimateCost(odd, RATES).total).toBe(1.67)
  })

  it('quotes nothing for a placement that is not on the card', () => {
    expect(estimateCost({ ...good, placementTier: 'invented' }, RATES).total).toBe(0)
    expect(fields({ placementTier: 'invented' })).toContain('placementTier')
  })

  it('quotes nothing for a window that makes no sense', () => {
    expect(hoursBetween('nonsense', good.endsAt)).toBe(0)
    expect(estimateCost({ ...good, endsAt: good.startsAt }, RATES).total).toBe(0)
  })
})
