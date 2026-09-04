import { PLACEMENTS, SponsorBatchSchema, SponsoredTileSchema } from '@shared/types/sponsor'
import { describe, it, expect } from 'vitest'
import { acceptCreative, isLive, reportUrlFor, selectLive, selectTile } from './sponsorRules'

const tile = (id: string): { id: string } => ({ id })

describe('selectTile', () => {
  it('is a query, not a mutation — the same rotation gives the same tile', () => {
    // The bug this exists to prevent: reading the current tile used to advance
    // the batch, so the click handler saw a different creative than the one
    // clicked, failed its own guard, and billed a click that opened nothing.
    const tiles = [tile('a'), tile('b'), tile('c')]
    expect(selectTile(tiles, 0)).toBe(selectTile(tiles, 0))
    expect(selectTile(tiles, 1)).toBe(selectTile(tiles, 1))
  })

  it('rotates evenly across the batch', () => {
    const tiles = [tile('a'), tile('b'), tile('c')]
    const seen = [0, 1, 2, 3, 4, 5].map((n) => selectTile(tiles, n)?.id)
    expect(seen).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
  })

  it('never lets one creative dominate a small batch', () => {
    const tiles = [tile('a'), tile('b')]
    const counts = new Map<string, number>()
    for (let n = 0; n < 100; n += 1) {
      const id = selectTile(tiles, n)!.id
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    expect(counts.get('a')).toBe(50)
    expect(counts.get('b')).toBe(50)
  })

  it('returns null for an empty batch rather than undefined', () => {
    expect(selectTile([], 0)).toBeNull()
    expect(selectTile([], 7)).toBeNull()
  })

  it('survives a rotation that is negative or not a number', () => {
    // A counter that wrapped or was restored from a bad value must not index
    // out of bounds and report the batch as empty.
    const tiles = [tile('a'), tile('b')]
    expect(selectTile(tiles, -1)).not.toBeNull()
    expect(selectTile(tiles, Number.NaN)?.id).toBe('a')
    expect(selectTile(tiles, 2.7)?.id).toBe('a')
  })
})

describe('acceptCreative', () => {
  const good = { id: 'ok', image: 'data:image/png;base64,AAAA', clickUrl: 'https://example.com/x' }

  it('accepts a creative with a local image and an https target', () => {
    expect(acceptCreative(good)).toEqual({ ok: true })
  })

  it('accepts a creative with no image at all', () => {
    expect(acceptCreative({ ...good, image: '' }).ok).toBe(true)
  })

  it('refuses a remote image, which would be a tracking pixel', () => {
    // The rule that keeps a tile from phoning the sponsor on every impression.
    const verdict = acceptCreative({ ...good, image: 'https://tracker.example/p.png' })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('data:')
  })

  it('refuses a protocol-relative or data-lookalike image', () => {
    expect(acceptCreative({ ...good, image: '//tracker.example/p.png' }).ok).toBe(false)
    expect(acceptCreative({ ...good, image: 'data:text/html,<script>' }).ok).toBe(false)
  })

  it('refuses a click target that is not https', () => {
    expect(acceptCreative({ ...good, clickUrl: 'http://example.com/x' }).ok).toBe(false)
    expect(acceptCreative({ ...good, clickUrl: 'javascript:alert(1)' }).ok).toBe(false)
    expect(acceptCreative({ ...good, clickUrl: 'file:///etc/passwd' }).ok).toBe(false)
  })
})

describe('reportUrlFor', () => {
  it('resolves beside a file endpoint rather than appending to it', () => {
    // Appending produced `…/tiles.json/report`, which is not a path anyone
    // would have set up on their server.
    expect(reportUrlFor('https://example.com/slash/tiles.json')).toBe(
      'https://example.com/slash/report'
    )
  })

  it('resolves inside a directory endpoint', () => {
    expect(reportUrlFor('https://example.com/slash/')).toBe('https://example.com/slash/report')
  })

  it('handles a bare origin', () => {
    expect(reportUrlFor('https://example.com')).toBe('https://example.com/report')
  })

  it('returns null for an unset or malformed endpoint', () => {
    // A bad setting must mean "do not report", not a thrown error inside a
    // background task.
    expect(reportUrlFor('')).toBeNull()
    expect(reportUrlFor('   ')).toBeNull()
    expect(reportUrlFor('not a url')).toBeNull()
  })
})

describe('isLive', () => {
  const AT = 1_700_000_000_000

  it('treats an unbounded window as always running', () => {
    expect(isLive({ startsAt: null, endsAt: null }, AT)).toBe(true)
  })

  it('does not run a campaign before it starts', () => {
    expect(isLive({ startsAt: AT + 1, endsAt: null }, AT)).toBe(false)
    expect(isLive({ startsAt: AT, endsAt: null }, AT)).toBe(true)
  })

  it('is half-open at the end, so an hour cannot be sold twice', () => {
    // A campaign ending at the same instant the next one starts must not still
    // be live at that instant, or both are shown for the moment they touch and
    // one advertiser is paying for time the other is also paying for.
    expect(isLive({ startsAt: null, endsAt: AT }, AT)).toBe(false)
    expect(isLive({ startsAt: null, endsAt: AT + 1 }, AT)).toBe(true)
  })

  it('honours both ends together', () => {
    const window = { startsAt: AT, endsAt: AT + 3_600_000 }
    expect(isLive(window, AT - 1)).toBe(false)
    expect(isLive(window, AT)).toBe(true)
    expect(isLive(window, AT + 3_599_999)).toBe(true)
    expect(isLive(window, AT + 3_600_000)).toBe(false)
  })
})

describe('selectLive', () => {
  const AT = 1_700_000_000_000
  const tile = (id: string, startsAt: number | null, endsAt: number | null) => ({
    id,
    startsAt,
    endsAt
  })

  it('skips a campaign that has not started and one that has finished', () => {
    const tiles = [
      tile('past', null, AT - 1),
      tile('now', AT - 1000, AT + 1000),
      tile('future', AT + 1000, null)
    ]
    expect(selectLive(tiles, 0, AT)?.id).toBe('now')
    expect(selectLive(tiles, 1, AT)?.id).toBe('now')
    expect(selectLive(tiles, 7, AT)?.id).toBe('now')
  })

  it('rotates evenly across only the live campaigns', () => {
    // Rotation applies after filtering, so a batch carrying days of future
    // scheduling still shows today's campaigns evenly instead of leaving gaps
    // where a scheduled one would have gone.
    const tiles = [
      tile('a', null, null),
      tile('scheduled', AT + 86_400_000, null),
      tile('b', null, null)
    ]
    expect([0, 1, 2, 3].map((r) => selectLive(tiles, r, AT)?.id)).toEqual(['a', 'b', 'a', 'b'])
  })

  it('returns null when everything cached is out of window', () => {
    // A batch can outlive every campaign in it. Showing nothing is correct;
    // showing a finished campaign is billing somebody for time they did not buy.
    const tiles = [tile('past', null, AT - 1), tile('future', AT + 1, null)]
    expect(selectLive(tiles, 0, AT)).toBeNull()
  })
})

describe('acceptCreative — scheduling', () => {
  const good = { id: '1', image: '', clickUrl: 'https://example.com/offer' }

  it('accepts a creative with no window at all', () => {
    expect(acceptCreative(good).ok).toBe(true)
  })

  it('accepts a well-ordered window', () => {
    expect(acceptCreative({ ...good, startsAt: 1000, endsAt: 2000 }).ok).toBe(true)
  })

  it('refuses a window that ends before it starts', () => {
    // Never runnable, so it is dropped at fetch rather than silently never
    // appearing — an operator should find out the same day.
    const verdict = acceptCreative({ ...good, startsAt: 2000, endsAt: 1000 })
    expect(verdict.ok).toBe(false)
    expect(verdict).toMatchObject({ reason: 'campaign ends before it starts' })
  })

  it('refuses a zero-length window', () => {
    expect(acceptCreative({ ...good, startsAt: 1000, endsAt: 1000 }).ok).toBe(false)
  })
})

describe('placement definitions', () => {
  it('every placement survives a round trip through the batch schema', () => {
    // These two schemas used to carry their own copies of the placement list.
    // The moment one gained a value the other rejected **the whole batch** —
    // not the unknown creative, the entire fetch — so every campaign vanished
    // at once and the only trace was a single line in a log.
    for (const placement of PLACEMENTS) {
      const batch = SponsorBatchSchema.safeParse({
        expiresAt: Date.now() + 1000,
        tiles: [
          {
            id: `id-${placement}`,
            sponsor: 'Example Co',
            headline: 'A headline',
            clickUrl: 'https://example.com/',
            placement
          }
        ]
      })
      expect(batch.success, `batch rejected placement "${placement}"`).toBe(true)
      if (!batch.success) continue

      const stored = SponsoredTileSchema.safeParse(batch.data.tiles[0])
      expect(stored.success, `stored schema rejected placement "${placement}"`).toBe(true)
    }
  })

  it('one unknown placement does not discard the whole batch silently', () => {
    // Documents the failure mode: the batch is rejected wholesale rather than
    // per creative, which is why the two lists must stay one list.
    const batch = SponsorBatchSchema.safeParse({
      expiresAt: Date.now() + 1000,
      tiles: [
        { id: 'a', sponsor: 'Co', headline: 'H', clickUrl: 'https://example.com/' },
        { id: 'b', sponsor: 'Co', headline: 'H', clickUrl: 'https://example.com/', placement: 'skywriting' }
      ]
    })
    expect(batch.success).toBe(false)
  })
})
