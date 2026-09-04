import { describe, expect, it } from 'vitest'
import type { Segment } from '@shared/types/downloadEngine'
import { MIN_SPLIT_BYTES, planSplit, remainingBytes } from './segmentSplitting'

const MB = 1024 * 1024

function segment(start: number, end: number, receivedBytes = 0): Segment {
  return { index: 0, start, end, receivedBytes }
}

/**
 * Every byte of [0, total) belongs to exactly one segment.
 *
 * The whole risk of dynamic segmentation is here. A gap or an overlap does not
 * throw and does not fail a request — it produces a file that downloads to
 * 100%, opens, and is quietly corrupt in the middle.
 */
function assertCovers(segments: readonly Segment[], total: number): void {
  const ordered = [...segments].sort((a, b) => a.start - b.start)
  let next = 0
  for (const part of ordered) {
    expect(part.start).toBe(next)
    expect(part.end).toBeGreaterThanOrEqual(part.start)
    next = part.end + 1
  }
  expect(next).toBe(total)
}

/** Applies a plan the way `SegmentedDownload.steal` does. */
function apply(segments: Segment[], plan: NonNullable<ReturnType<typeof planSplit>>): void {
  segments[plan.donorPosition]!.end = plan.donorNewEnd
  segments.push(plan.fresh)
}

describe('remainingBytes', () => {
  it('counts the bytes still to fetch, inclusive of the end', () => {
    expect(remainingBytes(segment(0, 99))).toBe(100)
    expect(remainingBytes(segment(0, 99, 40))).toBe(60)
  })

  it('is zero for a finished segment', () => {
    expect(remainingBytes(segment(0, 99, 100))).toBe(0)
  })
})

describe('planSplit', () => {
  it('refuses when every segment is too small to divide', () => {
    // Both halves have to clear the floor, so the whole must be twice it.
    expect(planSplit([segment(0, MIN_SPLIT_BYTES * 2 - 2)], 1)).toBeNull()
  })

  it('refuses when everything is finished — this is how a worker learns to stop', () => {
    expect(planSplit([segment(0, 99 * MB, 99 * MB + 1)], 1)).toBeNull()
  })

  it('takes from the segment with the most left, not the largest', () => {
    const segments = [
      // Big, but nearly done.
      { index: 0, start: 0, end: 100 * MB - 1, receivedBytes: 99 * MB },
      // Smaller, but barely started — this is the one holding the download up.
      { index: 1, start: 100 * MB, end: 140 * MB - 1, receivedBytes: 1 * MB }
    ]
    expect(planSplit(segments, 2)?.donorPosition).toBe(1)
  })

  it('splits the unfetched remainder, never the whole range', () => {
    // 40 MB fetched of 100. The remaining 60 splits into 30 and 30 — a split of
    // the *range* would hand over bytes already on disk.
    const segments = [segment(0, 100 * MB - 1, 40 * MB)]
    const plan = planSplit(segments, 1)!
    expect(plan.fresh.start).toBe(70 * MB)
    expect(plan.donorNewEnd).toBe(70 * MB - 1)
    expect(plan.fresh.end).toBe(100 * MB - 1)
  })

  it('never cuts the donor behind where it has already written', () => {
    // A donor left with an end below its own cursor would be asked for a
    // backwards range, and its bytes on disk would belong to nobody.
    for (const received of [0, 1, MB, 20 * MB, 49 * MB]) {
      const donor = segment(0, 50 * MB - 1, received)
      const plan = planSplit([donor], 1)
      if (!plan) continue
      expect(plan.donorNewEnd).toBeGreaterThanOrEqual(donor.start + donor.receivedBytes - 1)
    }
  })

  it('leaves both sides at least the floor', () => {
    const segments = [segment(0, 10 * MB - 1)]
    const plan = planSplit(segments, 1)!
    const donorLeft = plan.donorNewEnd - segments[0]!.start - segments[0]!.receivedBytes + 1
    expect(donorLeft).toBeGreaterThanOrEqual(MIN_SPLIT_BYTES)
    expect(plan.fresh.end - plan.fresh.start + 1).toBeGreaterThanOrEqual(MIN_SPLIT_BYTES)
  })

  it('keeps the file fully covered after a split', () => {
    const total = 100 * MB
    const segments = [segment(0, total - 1, 10 * MB)]
    apply(segments, planSplit(segments, 1)!)
    assertCovers(segments, total)
  })

  it('keeps the file fully covered through a whole run of steals', () => {
    // The real shape of the thing: split until nothing is splittable, checking
    // coverage at every step. One arithmetic slip anywhere shows up here.
    // 64 MB against a 1 MB floor bottoms out at 64 segments, so ~62 splits —
    // the cap below is headroom, not the thing under test.
    const total = 64 * MB
    const segments: Segment[] = [
      { index: 0, start: 0, end: total / 2 - 1, receivedBytes: 3 * MB },
      { index: 1, start: total / 2, end: total - 1, receivedBytes: 0 }
    ]
    let next = 2
    for (let step = 0; step < 500; step += 1) {
      const plan = planSplit(segments, next)
      if (!plan) break
      apply(segments, plan)
      next += 1
      assertCovers(segments, total)
    }
    // It must actually terminate rather than splitting for ever.
    expect(planSplit(segments, next)).toBeNull()
    expect(segments.length).toBeGreaterThan(2)
  })

  it('stays correct when donors keep fetching between steals', () => {
    // Closer to reality: the donor is *streaming* while the thief does its
    // arithmetic, so `receivedBytes` moves under a plan computed a tick ago.
    const total = 256 * MB
    const segments: Segment[] = [{ index: 0, start: 0, end: total - 1, receivedBytes: 0 }]
    let next = 1
    for (let step = 0; step < 300; step += 1) {
      for (const part of segments) {
        const room = remainingBytes(part)
        if (room > 0) part.receivedBytes += Math.min(room, 512 * 1024)
      }
      const plan = planSplit(segments, next)
      if (plan) {
        apply(segments, plan)
        next += 1
      }
      assertCovers(segments, total)
    }
  })

  it('gives each new segment a distinct identity', () => {
    const segments = [segment(0, 400 * MB - 1)]
    const first = planSplit(segments, 7)!
    apply(segments, first)
    const second = planSplit(segments, 8)!
    expect(first.fresh.index).toBe(7)
    expect(second.fresh.index).toBe(8)
  })
})
