import { describe, it, expect } from 'vitest'
import {
  BATCH_LOOKAHEAD_MS,
  BATCH_TTL_MS,
  acceptCreative,
  belongsInBatch,
  buildBatch,
  capBatchSize,
  toBatchTile,
  type BatchTile,
  type CampaignRow
} from './batch'

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0)
const iso = (msFromNow: number): string => new Date(NOW + msFromNow).toISOString()

const row = (overrides: Partial<CampaignRow> = {}): CampaignRow => ({
  id: 'c1',
  title: 'A headline',
  description: 'Supporting line',
  destination_link: 'https://example.com/offer',
  starts_at: iso(BATCH_TTL_MS),
  ends_at: iso(BATCH_TTL_MS * 5),
  advertisers: { company_name: 'Acme' },
  ...overrides
})

const tile = (overrides: Partial<BatchTile> = {}): BatchTile => ({
  id: 'c1',
  sponsor: 'Acme',
  headline: 'A headline',
  body: '',
  image: 'data:image/png;base64,AAAA',
  clickUrl: 'https://example.com/offer',
  startsAt: NOW,
  endsAt: NOW + BATCH_TTL_MS,
  ...overrides
})

describe('belongsInBatch', () => {
  it('includes a campaign that has not started yet', () => {
    // The whole reason an hour can be sold against a six-hourly fetch: the
    // browser is handed the window and starts the campaign itself.
    expect(belongsInBatch(row({ starts_at: iso(BATCH_TTL_MS) }), NOW)).toBe(true)
  })

  it('includes a campaign already running', () => {
    expect(
      belongsInBatch(row({ starts_at: iso(-BATCH_TTL_MS), ends_at: iso(BATCH_TTL_MS) }), NOW)
    ).toBe(true)
  })

  it('excludes one that has finished', () => {
    expect(belongsInBatch(row({ starts_at: iso(-10 * BATCH_TTL_MS), ends_at: iso(-1) }), NOW)).toBe(
      false
    )
  })

  it('excludes one starting beyond the lookahead', () => {
    expect(belongsInBatch(row({ starts_at: iso(BATCH_LOOKAHEAD_MS + 1) }), NOW)).toBe(false)
  })

  it('reaches far enough ahead to survive a missed refresh', () => {
    // A machine that misses one refresh must still be holding what starts
    // before the next one — otherwise the campaign silently skips it.
    expect(belongsInBatch(row({ starts_at: iso(BATCH_TTL_MS + 1) }), NOW)).toBe(true)
  })

  it('refuses a row with unparseable dates rather than serving NaN', () => {
    expect(belongsInBatch({ starts_at: 'not a date', ends_at: iso(BATCH_TTL_MS) }, NOW)).toBe(false)
  })
})

describe('toBatchTile', () => {
  it('produces exactly the shape the browser parses', () => {
    // The browser parses the whole batch or ignores the whole batch, so a
    // drifted field takes every advert off every start page at once.
    const result = toBatchTile(row(), 'data:image/png;base64,AAAA')
    expect(Object.keys(result).sort()).toEqual([
      'body',
      'clickUrl',
      'endsAt',
      'headline',
      'id',
      'image',
      'sponsor',
      'startsAt'
    ])
    expect(result.sponsor).toBe('Acme')
    expect(result.startsAt).toBe(NOW + BATCH_TTL_MS)
  })

  it('sends an empty body rather than null when there is no description', () => {
    // The browser's schema defaults body to '' — null would fail the parse and
    // take the batch down with it.
    expect(toBatchTile(row({ description: null }), '').body).toBe('')
  })

  it('carries an empty sponsor through so acceptCreative can refuse it', () => {
    expect(toBatchTile(row({ advertisers: null }), '').sponsor).toBe('')
  })
})

describe('acceptCreative', () => {
  it('accepts a well-formed tile', () => {
    expect(acceptCreative(tile()).ok).toBe(true)
  })

  it('refuses a linked image', () => {
    // A remote <img src> is a request to us on every impression, on every
    // machine — the per-impression tracking the browser exists to avoid, which
    // is why it drops these on its own side too.
    const verdict = acceptCreative(tile({ image: 'https://cdn.example.com/ad.png' }))
    expect(verdict).toEqual({ ok: false, reason: 'image is not a data: URL' })
  })

  it('accepts a tile with no image at all', () => {
    expect(acceptCreative(tile({ image: '' })).ok).toBe(true)
  })

  it('refuses a non-https destination', () => {
    expect(acceptCreative(tile({ clickUrl: 'http://example.com' })).ok).toBe(false)
    expect(acceptCreative(tile({ clickUrl: 'javascript:alert(1)' })).ok).toBe(false)
  })

  it('refuses a nameless sponsor', () => {
    // "Sponsored" without saying by whom is the thing this tile format exists
    // not to be.
    expect(acceptCreative(tile({ sponsor: '   ' })).ok).toBe(false)
  })

  it('refuses a window that ends before it starts', () => {
    expect(acceptCreative(tile({ startsAt: 2000, endsAt: 1000 })).ok).toBe(false)
  })
})

describe('capBatchSize', () => {
  const withImage = (id: string, bytes: number): BatchTile =>
    tile({ id, image: 'data:image/png;base64,' + 'A'.repeat(bytes) })

  it('keeps tiles until the budget runs out', () => {
    const { kept, dropped } = capBatchSize([withImage('a', 100), withImage('b', 100)], 400)
    expect(kept.map((t) => t.id)).toEqual(['a', 'b'])
    expect(dropped).toEqual([])
  })

  it('drops the overflow rather than truncating the JSON', () => {
    const { kept, dropped } = capBatchSize(
      [withImage('a', 300), withImage('b', 300), withImage('c', 300)],
      700
    )
    expect(kept.map((t) => t.id)).toEqual(['a', 'b'])
    expect(dropped.map((t) => t.id)).toEqual(['c'])
  })

  it('always keeps at least one tile, even an oversized one', () => {
    // Otherwise a single large creative empties the batch for everybody, which
    // is a worse failure than one big download.
    const { kept, dropped } = capBatchSize([withImage('big', 5000)], 100)
    expect(kept.map((t) => t.id)).toEqual(['big'])
    expect(dropped).toEqual([])
  })
})

describe('buildBatch', () => {
  it('stamps an expiry the browser will honour', () => {
    expect(buildBatch([], NOW).expiresAt).toBe(NOW + BATCH_TTL_MS)
  })
})

describe('embedded relations', () => {
  it('reads a sponsor name whether PostgREST returns an object or an array', () => {
    // The two shapes are not distinguishable from the query. Reading only the
    // object shape would make every sponsor name undefined the day the
    // inference changed — every creative would fail acceptCreative and the
    // batch would empty for everyone, with nothing logged naming the cause.
    expect(toBatchTile(row({ advertisers: { company_name: 'Acme' } }), '').sponsor).toBe('Acme')
    expect(toBatchTile(row({ advertisers: [{ company_name: 'Acme' }] }), '').sponsor).toBe('Acme')
    expect(toBatchTile(row({ advertisers: [] }), '').sponsor).toBe('')
    expect(toBatchTile(row({ advertisers: null }), '').sponsor).toBe('')
  })
})
