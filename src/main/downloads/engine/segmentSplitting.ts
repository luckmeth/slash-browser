import type { Segment } from '@shared/types/downloadEngine'

/**
 * The smallest tail worth handing to a fresh connection.
 *
 * A new segment costs a TCP handshake, a TLS handshake and a slow-start ramp
 * before it carries useful bytes. Below about a megabyte that setup takes
 * longer than simply letting the original connection finish the range itself,
 * so splitting smaller than this makes the download *slower* while making the
 * progress display busier — the worst possible trade.
 *
 * Lower than `MIN_SEGMENT_BYTES` (2 MB), which governs the *initial* split,
 * and deliberately so: at planning time nothing has been fetched and a
 * too-eager split wastes connections on a file that never needed them, whereas
 * by the time this applies the alternative is a connection sitting idle.
 */
export const MIN_SPLIT_BYTES = 1024 * 1024

export interface SplitPlan {
  /** Position in the array — not `Segment.index`, which is an identity. */
  readonly donorPosition: number
  /** What the donor's `end` becomes. It keeps everything up to here. */
  readonly donorNewEnd: number
  /** The tail, for the connection that asked. */
  readonly fresh: Segment
}

/** Bytes of this segment still to fetch. */
export function remainingBytes(segment: Segment): number {
  return segment.end - (segment.start + segment.receivedBytes) + 1
}

/**
 * Takes half of the least-finished segment and hands it to an idle connection.
 *
 * This is the difference between a segmented downloader and a fast one, and it
 * is the thing IDM means by "dynamic file segmentation". A static split — the
 * file cut into N equal ranges at the start, one connection each — finishes no
 * sooner than its *slowest* connection. One segment served from a congested
 * CDN node, or shaped by the ISP, or simply unlucky, holds the whole download
 * while the other seven connections have finished and gone idle. On a real
 * transfer that is routinely a doubling of the total time.
 *
 * So a connection that runs out of work does not exit. It finds whichever
 * segment has the most bytes left, cuts the *unfetched remainder* in half, and
 * takes the second half. The donor is mid-flight and keeps streaming, but now
 * stops at its new end — `SegmentedDownload.fetchSegment` re-reads `end` after
 * every chunk for exactly this reason.
 *
 * Pure, because the arithmetic is where this goes wrong. An off-by-one here
 * does not throw and does not fail a request: it writes a file with a gap or an
 * overlap in the middle, which downloads to 100%, opens, and is corrupt. The
 * coverage invariant is asserted in the tests rather than argued for here.
 *
 * Returns `null` when nothing is worth splitting, which is how a worker learns
 * to stop.
 */
export function planSplit(
  segments: readonly Segment[],
  nextIndex: number,
  minSplitBytes: number = MIN_SPLIT_BYTES
): SplitPlan | null {
  let donorPosition = -1
  let best = 0

  for (let position = 0; position < segments.length; position += 1) {
    const remaining = remainingBytes(segments[position]!)
    // Both halves must clear the floor, or the split is not worth making.
    if (remaining < minSplitBytes * 2) continue
    // Strictly greater keeps ties on the earliest segment, so the choice is
    // deterministic and the tests mean something.
    if (remaining > best) {
      best = remaining
      donorPosition = position
    }
  }

  if (donorPosition < 0) return null

  const donor = segments[donorPosition]!
  // The next byte the donor will write. Splitting anywhere at or behind this
  // would hand over bytes it has already put on disk, and — worse — give the
  // donor an end below its own cursor.
  const cursor = donor.start + donor.receivedBytes
  const splitAt = cursor + Math.floor(best / 2)

  return {
    donorPosition,
    donorNewEnd: splitAt - 1,
    fresh: { index: nextIndex, start: splitAt, end: donor.end, receivedBytes: 0 }
  }
}
