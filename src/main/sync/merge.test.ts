import { describe, it, expect } from 'vitest'
import { expiredTombstones, mergeItems, nextCursor, pickWinner, type SyncItem } from './merge'

const item = (over: Partial<SyncItem> & { id: string }): SyncItem => ({
  collection: 'bookmarks',
  updatedAt: 100,
  deleted: false,
  payload: 'cipher',
  ...over
})

describe('pickWinner', () => {
  it('takes the newer edit', () => {
    expect(pickWinner(item({ id: 'a', updatedAt: 1 }), item({ id: 'a', updatedAt: 2 })).updatedAt).toBe(2)
    expect(pickWinner(item({ id: 'a', updatedAt: 5 }), item({ id: 'a', updatedAt: 2 })).updatedAt).toBe(5)
  })

  it('resolves a tie towards the deletion', () => {
    // Not because delete is more likely right — because every device resolving
    // it the same way matters more than which way. A coin-flip leaves two
    // machines disagreeing for ever.
    const local = item({ id: 'a', updatedAt: 7 })
    const remote = item({ id: 'a', updatedAt: 7, deleted: true })
    expect(pickWinner(local, remote).deleted).toBe(true)
    expect(pickWinner(remote, local).deleted).toBe(true)
  })
})

describe('mergeItems', () => {
  it('brings down an item this machine has never seen', () => {
    const result = mergeItems([], [item({ id: 'a' })])
    expect(result.toApply.map((i) => i.id)).toEqual(['a'])
    expect(result.toPush).toEqual([])
  })

  it('pushes an item the server has never seen', () => {
    const result = mergeItems([item({ id: 'a' })], [])
    expect(result.toPush.map((i) => i.id)).toEqual(['a'])
    expect(result.toApply).toEqual([])
  })

  it('merges per item, not per collection', () => {
    // Per-collection merging means whichever machine syncs second silently
    // discards every edit the first one made.
    const local = [item({ id: 'a', updatedAt: 200 }), item({ id: 'b', updatedAt: 50 })]
    const remote = [item({ id: 'a', updatedAt: 100 }), item({ id: 'b', updatedAt: 150 })]
    const result = mergeItems(local, remote)
    expect(result.toPush.map((i) => i.id)).toEqual(['a'])
    expect(result.toApply.map((i) => i.id)).toEqual(['b'])
    expect(result.merged.length).toBe(2)
  })

  it('applies a remote deletion rather than re-uploading the item', () => {
    // Without tombstones, "missing here" is indistinguishable from "new there"
    // and every deleted bookmark comes back the moment another device syncs.
    const result = mergeItems(
      [item({ id: 'a', updatedAt: 100 })],
      [item({ id: 'a', updatedAt: 200, deleted: true })]
    )
    expect(result.toApply[0]?.deleted).toBe(true)
    expect(result.toPush).toEqual([])
  })

  it('keeps a local deletion that is newer than the remote edit', () => {
    const result = mergeItems(
      [item({ id: 'a', updatedAt: 300, deleted: true })],
      [item({ id: 'a', updatedAt: 200 })]
    )
    expect(result.toPush[0]?.deleted).toBe(true)
    expect(result.toApply).toEqual([])
  })

  it('does nothing when both sides already agree', () => {
    const same = item({ id: 'a' })
    const result = mergeItems([same], [{ ...same }])
    expect(result.toPush).toEqual([])
    expect(result.toApply).toEqual([])
    expect(result.merged.length).toBe(1)
  })

  it('keeps items of the same id in different collections apart', () => {
    // Ids are only unique within their own table; merging on id alone would
    // have a bookmark overwrite a reading-list entry that happened to share one.
    const result = mergeItems(
      [item({ id: '1', collection: 'bookmarks', updatedAt: 100 })],
      [item({ id: '1', collection: 'reading', updatedAt: 200 })]
    )
    expect(result.merged.length).toBe(2)
    expect(result.toPush.length).toBe(1)
    expect(result.toApply.length).toBe(1)
  })

  it('produces exactly one entry per id', () => {
    const result = mergeItems(
      [item({ id: 'a' }), item({ id: 'b' })],
      [item({ id: 'a', updatedAt: 999 }), item({ id: 'c' })]
    )
    expect(result.merged.map((i) => i.id).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('nextCursor', () => {
  it('uses the newest timestamp actually received', () => {
    expect(nextCursor([item({ id: 'a', updatedAt: 50 }), item({ id: 'b', updatedAt: 90 })], 10)).toBe(90)
  })

  it('never moves backwards', () => {
    expect(nextCursor([item({ id: 'a', updatedAt: 5 })], 100)).toBe(100)
  })

  it('stays put when nothing came back', () => {
    // Advancing to the local clock here would skip every change written in the
    // gap between this machine's clock and the server's — silently, and only on
    // the machine whose clock is wrong.
    expect(nextCursor([], 42)).toBe(42)
  })
})

describe('expiredTombstones', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000

  it('keeps a recent tombstone so offline devices still learn of the deletion', () => {
    expect(expiredTombstones([item({ id: 'a', deleted: true, updatedAt: 1000 })], 1000 + WEEK, 90 * WEEK)).toEqual([])
  })

  it('forgets an old one so the table does not only ever grow', () => {
    const old = item({ id: 'a', deleted: true, updatedAt: 0 })
    expect(expiredTombstones([old], 100 * WEEK, 90 * WEEK).map((i) => i.id)).toEqual(['a'])
  })

  it('never expires a live item', () => {
    expect(expiredTombstones([item({ id: 'a', updatedAt: 0 })], 100 * WEEK, WEEK)).toEqual([])
  })
})
