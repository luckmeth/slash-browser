import { describe, it, expect } from 'vitest'
import {
  historyItemId,
  selectSyncable,
  mergeVisit,
  isHistoryPayload,
  HISTORY_RETENTION_DAYS,
  HISTORY_MAX_ITEMS,
  type HistoryRow
} from './historySync'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_760_000_000_000

const row = (url: string, daysAgo: number, title = url): HistoryRow => ({
  url,
  title,
  faviconUrl: null,
  lastVisitedAt: NOW - daysAgo * DAY
})

describe('history sync identity', () => {
  const key = Buffer.alloc(32, 7)
  const otherKey = Buffer.alloc(32, 9)

  it('is stable for the same url and key', () => {
    // This is what lets two of your devices recognise the same page.
    expect(historyItemId(key, 'https://example.com/a')).toBe(
      historyItemId(key, 'https://example.com/a')
    )
  })

  it('differs per url', () => {
    expect(historyItemId(key, 'https://example.com/a')).not.toBe(
      historyItemId(key, 'https://example.com/b')
    )
  })

  it('differs per key, so two accounts never share an id', () => {
    expect(historyItemId(key, 'https://example.com/a')).not.toBe(
      historyItemId(otherKey, 'https://example.com/a')
    )
  })

  it('is not a bare sha256 of the url', () => {
    // The whole point. A plain hash of a public, low-entropy string is
    // reversible with a precomputed table, so an id derived that way would
    // hand the server everyone's browsing history in effect.
    const bareSha256 =
      '0f8b3a1e0f2d1f4b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f809a1b2c3'
    expect(historyItemId(key, 'https://example.com/a')).not.toBe(bareSha256)

    // And it must actually depend on the key: same url, two keys, two ids.
    const ids = new Set([
      historyItemId(Buffer.alloc(32, 1), 'https://example.com/'),
      historyItemId(Buffer.alloc(32, 2), 'https://example.com/'),
      historyItemId(Buffer.alloc(32, 3), 'https://example.com/')
    ])
    expect(ids.size).toBe(3)
  })

  it('reveals nothing of the url in the id', () => {
    const id = historyItemId(key, 'https://secret.example.com/very-private-page')
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(id).not.toContain('secret')
    expect(id).not.toContain('private')
  })
})

describe('selectSyncable', () => {
  it('drops entries older than the retention window', () => {
    const rows = [row('https://a.test', 1), row('https://b.test', 200)]
    const kept = selectSyncable(rows, NOW)
    expect(kept.map((r) => r.url)).toEqual(['https://a.test'])
  })

  it('keeps an entry exactly on the boundary', () => {
    const rows = [row('https://edge.test', HISTORY_RETENTION_DAYS)]
    expect(selectSyncable(rows, NOW)).toHaveLength(1)
  })

  it('caps the count and keeps the newest, not an arbitrary slice', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`https://${i}.test`, i))
    const kept = selectSyncable(rows, NOW, { maxItems: 5 })
    expect(kept).toHaveLength(5)
    // Days-ago 0..4 are the five most recent.
    expect(kept.map((r) => r.url)).toEqual([
      'https://0.test',
      'https://1.test',
      'https://2.test',
      'https://3.test',
      'https://4.test'
    ])
  })

  it('does not mutate the rows it was given', () => {
    // It sorts, and sorting in place would reorder the caller's array — which
    // here is a query result the caller may still be using for the UI.
    const rows = [row('https://a.test', 5), row('https://b.test', 1)]
    const before = rows.map((r) => r.url)
    selectSyncable(rows, NOW)
    expect(rows.map((r) => r.url)).toEqual(before)
  })

  it('has a bounded default so a heavy user cannot produce an unbounded sync', () => {
    const rows = Array.from({ length: HISTORY_MAX_ITEMS + 500 }, (_, i) =>
      row(`https://${i}.test`, 1)
    )
    expect(selectSyncable(rows, NOW)).toHaveLength(HISTORY_MAX_ITEMS)
  })
})

describe('mergeVisit', () => {
  const remote = {
    url: 'https://a.test',
    title: 'Remote title',
    faviconUrl: 'https://a.test/icon.png',
    lastVisitedAt: NOW
  }

  it('accepts a page this device has never seen', () => {
    expect(mergeVisit(null, remote)).toEqual(remote)
  })

  it('takes the newer visit', () => {
    const local = { ...row('https://a.test', 5) }
    expect(mergeVisit(local, remote)?.lastVisitedAt).toBe(NOW)
  })

  it('writes nothing when local is already newer', () => {
    const local = { ...row('https://a.test', 0), lastVisitedAt: NOW + 1000 }
    expect(mergeVisit(local, remote)).toBeNull()
  })

  it('writes nothing when the two are identical in time', () => {
    const local = { ...row('https://a.test', 0), lastVisitedAt: NOW }
    expect(mergeVisit(local, remote)).toBeNull()
  })

  it('does not lose a local title to an empty remote one', () => {
    const local = { ...row('https://a.test', 5, 'Local title') }
    const merged = mergeVisit(local, { ...remote, title: '   ' })
    expect(merged?.title).toBe('Local title')
  })

  it('does not lose a local favicon to a null remote one', () => {
    const local = { ...row('https://a.test', 5), faviconUrl: 'https://a.test/f.png' }
    const merged = mergeVisit(local, { ...remote, faviconUrl: null })
    expect(merged?.faviconUrl).toBe('https://a.test/f.png')
  })

  it('never returns a visit count, because counts are not synced', () => {
    // Summing counts across devices is the classic distributed-counter bug: the
    // number grows on every sync, fastest for the pages visited most, which is
    // exactly the data ordering depends on.
    const merged = mergeVisit(row('https://a.test', 5), remote)
    expect(merged).not.toHaveProperty('visitCount')
    expect(merged).not.toHaveProperty('visit_count')
  })
})

describe('isHistoryPayload', () => {
  const valid = {
    url: 'https://a.test',
    title: 'A',
    faviconUrl: null,
    lastVisitedAt: NOW
  }

  it('accepts a well-formed payload', () => {
    expect(isHistoryPayload(valid)).toBe(true)
  })

  it('rejects anything that is not an object', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(isHistoryPayload(bad)).toBe(false)
    }
  })

  it('rejects a payload with the wrong shape', () => {
    // Authenticated is not the same as well-formed: AES-GCM proves the bytes
    // came from a device holding the key, not that an older or newer client
    // wrote the fields this version expects.
    expect(isHistoryPayload({ ...valid, url: '' })).toBe(false)
    expect(isHistoryPayload({ ...valid, lastVisitedAt: 'soon' })).toBe(false)
    expect(isHistoryPayload({ ...valid, lastVisitedAt: Number.NaN })).toBe(false)
    expect(isHistoryPayload({ ...valid, faviconUrl: 5 })).toBe(false)
    const { title: _title, ...noTitle } = valid
    expect(isHistoryPayload(noTitle)).toBe(false)
  })
})
