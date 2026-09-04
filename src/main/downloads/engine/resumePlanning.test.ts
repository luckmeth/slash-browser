import { describe, expect, it } from 'vitest'
import type { Segment, ServerCapabilities } from '@shared/types/downloadEngine'
import {
  canContinue,
  planSegments,
  recoveredState,
  resumeIsSafe,
  resumePlan,
  segmentIsComplete
} from './planning'

const segment = (index: number, start: number, end: number, receivedBytes: number): Segment => ({
  index,
  start,
  end,
  receivedBytes
})

const capabilities = (over: Partial<ServerCapabilities> = {}): ServerCapabilities => ({
  totalBytes: 1000,
  acceptsRanges: true,
  suggestedName: null,
  mimeType: 'application/octet-stream',
  etag: '"abc"',
  lastModified: null,
  ...over
})

describe('segmentIsComplete', () => {
  it('counts an inclusive range as finished only when every byte is there', () => {
    // Bytes 0-999 is one thousand bytes, not 999. Getting this wrong either
    // re-downloads a finished segment or, far worse, calls an unfinished one
    // done and leaves a hole in a file that looks complete.
    expect(segmentIsComplete(segment(0, 0, 999, 999))).toBe(false)
    expect(segmentIsComplete(segment(0, 0, 999, 1000))).toBe(true)
  })

  it('handles a single-byte range', () => {
    expect(segmentIsComplete(segment(0, 5, 5, 0))).toBe(false)
    expect(segmentIsComplete(segment(0, 5, 5, 1))).toBe(true)
  })

  it('treats an untouched segment as unfinished', () => {
    expect(segmentIsComplete(segment(0, 0, 100, 0))).toBe(false)
  })
})

describe('resumePlan', () => {
  it('leaves out the segments already on disk', () => {
    // The claim the whole feature rests on: resuming must not re-fetch what has
    // already been paid for.
    const plan = resumePlan([
      segment(0, 0, 249, 250), // done
      segment(1, 250, 499, 100), // part way
      segment(2, 500, 749, 0), // untouched
      segment(3, 750, 999, 250) // done
    ])

    expect(plan.remaining.map((s) => s.index)).toEqual([1, 2])
  })

  it('reports what is already held, so progress does not restart at zero', () => {
    const plan = resumePlan([segment(0, 0, 499, 500), segment(1, 500, 999, 120)])
    expect(plan.alreadyHave).toBe(620)
    expect(plan.total).toBe(1000)
  })

  it('has nothing left to do when every segment is complete', () => {
    const plan = resumePlan([segment(0, 0, 499, 500), segment(1, 500, 999, 500)])
    expect(plan.remaining).toEqual([])
    expect(plan.alreadyHave).toBe(plan.total)
  })

  it('copies the segments rather than handing back the live table', () => {
    // The fetch loop mutates `receivedBytes` in place. A plan that aliased it
    // would change under the caller as bytes arrived.
    const live = [segment(0, 0, 999, 10)]
    const plan = resumePlan(live)
    plan.remaining[0]!.receivedBytes = 999
    expect(live[0]!.receivedBytes).toBe(10)
  })

  it('agrees with planSegments about coverage', () => {
    // Guards the two halves against drifting apart: a plan built by one and
    // resumed by the other has to describe the same file.
    const planned = planSegments(10_000, 4)
    const plan = resumePlan(planned)
    expect(plan.total).toBe(10_000)
    expect(plan.remaining).toHaveLength(4)
  })
})

describe('canContinue', () => {
  it('accepts a complete segment table over a ranged server', () => {
    expect(canContinue(capabilities(), planSegments(1000, 4))).toBe(true)
  })

  it('refuses when the server will not serve ranges', () => {
    // Without ranges there is no way to ask for the missing middle of a file.
    expect(canContinue(capabilities({ acceptsRanges: false }), planSegments(1000, 4))).toBe(false)
  })

  it('refuses when the length was never known', () => {
    expect(canContinue(capabilities({ totalBytes: null }), [segment(0, 0, -1, 0)])).toBe(false)
  })

  it('refuses an empty segment table', () => {
    expect(canContinue(capabilities(), [])).toBe(false)
  })

  it('refuses a segment table that does not add up to the file', () => {
    // A table covering 900 of 1000 bytes would resume and report success with a
    // hole in it. Better to start again than to produce a file that is wrong.
    expect(canContinue(capabilities(), [segment(0, 0, 899, 0)])).toBe(false)
  })

  it('refuses when there are no capabilities at all', () => {
    expect(canContinue(null, planSegments(1000, 4))).toBe(false)
  })
})

describe('resumeIsSafe, as the queue uses it', () => {
  it('continues when a strong ETag still matches', () => {
    expect(resumeIsSafe(capabilities(), capabilities()).safe).toBe(true)
  })

  it('refuses when the file changed under us', () => {
    const verdict = resumeIsSafe(capabilities(), capabilities({ etag: '"different"' }))
    expect(verdict.safe).toBe(false)
    expect(verdict.reason).toContain('changed')
  })

  it('refuses a weak validator, which cannot promise identical bytes', () => {
    const verdict = resumeIsSafe(capabilities(), capabilities({ etag: 'W/"abc"' }))
    expect(verdict.safe).toBe(false)
  })

  it('refuses when the server offers no validator at all', () => {
    const bare = capabilities({ etag: null, lastModified: null })
    expect(resumeIsSafe(bare, bare).safe).toBe(false)
  })

  it('falls back to Last-Modified when there is no ETag', () => {
    const before = capabilities({ etag: null, lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' })
    expect(resumeIsSafe(before, before).safe).toBe(true)
  })

  it('refuses when the size changed, whatever the validator says', () => {
    const verdict = resumeIsSafe(capabilities(), capabilities({ totalBytes: 2000 }))
    expect(verdict.safe).toBe(false)
  })
})

describe('recoveredState', () => {
  it('brings a transfer that was running back paused, not running', () => {
    // Neither state describes anything real after a restart: the process that
    // owned the sockets is gone. Coming back "downloading" would show a bar
    // that never moves.
    expect(recoveredState('downloading')).toBe('paused')
    expect(recoveredState('probing')).toBe('paused')
  })

  it('does not resume anything by itself', () => {
    // The deliberate product decision. Silently restarting several large
    // transfers the moment somebody opens their browser spends their bandwidth
    // without asking, so a stopped download waits for a click.
    expect(recoveredState('downloading')).not.toBe('queued')
  })

  it('leaves instructions to start exactly as they were', () => {
    // Queued and scheduled were already "please run this".
    expect(recoveredState('queued')).toBe('queued')
  })

  it('leaves history alone', () => {
    expect(recoveredState('completed')).toBe('completed')
    expect(recoveredState('failed')).toBe('failed')
    expect(recoveredState('cancelled')).toBe('cancelled')
    expect(recoveredState('paused')).toBe('paused')
  })
})
