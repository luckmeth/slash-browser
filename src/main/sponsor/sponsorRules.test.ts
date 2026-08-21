import { describe, it, expect } from 'vitest'
import { acceptCreative, reportUrlFor, selectTile } from './sponsorRules'

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
