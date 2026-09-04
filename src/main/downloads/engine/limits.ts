/**
 * Ceilings on what a downloaded description of a download may ask for.
 *
 * A manifest is a file fetched from a page the user merely visited, and it
 * tells this engine how many requests to make and how much to write. Left
 * unbounded that is a denial of service with no exploit required: a playlist
 * listing a million segments is four hundred kilobytes of text and hours of
 * requests, and a `SegmentTimeline` with `r="999999999"` is one line.
 *
 * Gathered here rather than scattered as magic numbers, because a limit nobody
 * can find is a limit nobody can review — and because the numbers need to be
 * defensible next to each other rather than one at a time.
 */
export const MEDIA_LIMITS = {
  /**
   * Bytes of manifest text.
   *
   * A two-hour HLS playlist is a few hundred kilobytes. Eight megabytes is
   * already far past anything legitimate, and holding it in memory to parse is
   * the cost being bounded.
   */
  maxManifestBytes: 8 * 1024 * 1024,

  /**
   * Segments in one stream.
   *
   * A two-hour film at two seconds a segment is 3,600. Twenty thousand allows
   * for one-second segments across the same length with room to spare, and
   * still bounds the request count to something a server would not call abuse.
   */
  maxSegments: 20_000,

  /**
   * Quality variants offered by one master playlist.
   *
   * Real ones list between three and a dozen. A hundred is generous; more than
   * that is a list nobody can choose from and a picker nobody can scroll.
   */
  maxVariants: 100,

  /**
   * Redirect hops for one request.
   *
   * Video CDNs routinely use three or four. Ten is loop protection, not a
   * budget.
   */
  maxRedirects: 10,

  /**
   * Bytes for one segment held in memory before it is written.
   *
   * Segments are buffered until their turn, because they must be written in
   * order. A hostile server answering one segment with an endless body would
   * otherwise grow the process until it died.
   */
  maxSegmentBytes: 256 * 1024 * 1024,

  /**
   * Total bytes a single download may write.
   *
   * Not a policy about large files — 64 GB is larger than anything a browser
   * download realistically is — but a backstop against a server that never
   * stops sending, which would otherwise fill the disk.
   */
  maxDownloadBytes: 64 * 1024 * 1024 * 1024
} as const

export type LimitName = keyof typeof MEDIA_LIMITS

/** What to tell somebody when a limit stopped their download. */
export function limitMessage(limit: LimitName): string {
  switch (limit) {
    case 'maxManifestBytes':
      return 'This stream’s playlist is too large to read safely, so Slash has stopped rather than trying.'
    case 'maxSegments':
      return `This stream lists more than ${MEDIA_LIMITS.maxSegments.toLocaleString()} segments, which is more than Slash will fetch for one download.`
    case 'maxVariants':
      return 'This stream lists an unreasonable number of qualities, so Slash has stopped rather than trying.'
    case 'maxRedirects':
      return 'This download redirected too many times to follow.'
    case 'maxSegmentBytes':
      return 'One piece of this stream was larger than Slash will hold in memory.'
    case 'maxDownloadBytes':
      return 'This download grew past the size Slash will write for a single file.'
    default:
      return 'This download went past a safety limit and has been stopped.'
  }
}

/**
 * Whether a count is within its ceiling, with the message if it is not.
 *
 * Returning the reason rather than a boolean is the point: every one of these
 * has to reach the user as a sentence, because a download that stops with no
 * explanation is indistinguishable from one that is broken.
 */
export function withinLimit(
  value: number,
  limit: LimitName
): { ok: true } | { ok: false; reason: string } {
  return value <= MEDIA_LIMITS[limit] ? { ok: true } : { ok: false, reason: limitMessage(limit) }
}
