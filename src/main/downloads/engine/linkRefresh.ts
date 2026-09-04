import type { ServerCapabilities } from '@shared/types/downloadEngine'

export interface RefreshVerdict {
  /** Whether the partial file on disk may be continued from the new address. */
  readonly continueFromPartial: boolean
  /** Whether the new address may be used at all. */
  readonly usable: boolean
  readonly reason: string
}

/**
 * Whether a new address serves the same bytes as the one that expired.
 *
 * Media CDNs hand out links that stop working after a few hours, and a download
 * paused overnight comes back to a 403 with a perfectly good half-file beside
 * it. Refreshing the address is the fix, and it is also the single easiest way
 * in this engine to produce a corrupt file that looks complete: continue a
 * partial from a *different* video and the two halves splice together into
 * something that plays, briefly, and is wrong.
 *
 * So the new address has to prove itself the same file. The strong evidence is
 * a matching validator - an ETag, or failing that Last-Modified - which is what
 * `resumeIsSafe` already demands of a resume against the same URL. A refreshed
 * CDN link often carries neither, and then the only thing left is the length.
 *
 * A matching length is **not** proof and is not treated as it. It is accepted
 * only to start again from zero, which throws away the partial and costs time
 * rather than correctness. The one thing never done is continuing a partial on
 * the strength of a byte count.
 */
export function refreshVerdict(
  previous: ServerCapabilities,
  next: ServerCapabilities
): RefreshVerdict {
  if (!next.acceptsRanges && next.totalBytes === null) {
    return {
      continueFromPartial: false,
      usable: false,
      reason: 'That address did not answer with a file.'
    }
  }

  const bothSized = previous.totalBytes !== null && next.totalBytes !== null
  if (bothSized && previous.totalBytes !== next.totalBytes) {
    return {
      continueFromPartial: false,
      usable: true,
      reason:
        `That address serves a different file — ${next.totalBytes} bytes against ` +
        `${previous.totalBytes}. Downloading it will start from the beginning.`
    }
  }

  const etagsAgree =
    previous.etag !== null && next.etag !== null && previous.etag === next.etag
  const datesAgree =
    previous.lastModified !== null &&
    next.lastModified !== null &&
    previous.lastModified === next.lastModified

  if (!next.acceptsRanges) {
    return {
      continueFromPartial: false,
      usable: true,
      reason: 'That address does not support ranges, so the download starts again from the beginning.'
    }
  }

  if (etagsAgree || datesAgree) {
    return {
      continueFromPartial: true,
      usable: true,
      reason: etagsAgree
        ? 'Same file — the server gave the same ETag, so the part already downloaded is kept.'
        : 'Same file — the server reports the same modification date, so the part already downloaded is kept.'
    }
  }

  return {
    continueFromPartial: false,
    usable: true,
    reason:
      'The new address is the right size but carries nothing to prove it is the same file, ' +
      'so this starts again rather than risk splicing two different files together.'
  }
}
