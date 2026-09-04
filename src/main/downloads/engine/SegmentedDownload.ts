import { createWriteStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import type { net } from 'electron'
import type { Segment, ServerCapabilities } from '@shared/types/downloadEngine'
import { createLogger } from '../../logger'
import { sendMediaRequest, type MediaRequestContext } from './requestContext'
import { planSegments, readCapabilities, resumeIsSafe, segmentIsComplete } from './planning'
import { classifyFailure } from './retryPolicy'
import { planSplit } from './segmentSplitting'

const log = createLogger('download')

/** Redirect hops before we assume a loop. */
const MAX_REDIRECTS = 10

/** Attempts for one segment before its failure becomes the transfer's failure. */
const SEGMENT_ATTEMPTS = 3
const SEGMENT_RETRY_BASE_MS = 500
const SEGMENT_RETRY_CAP_MS = 5_000

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface SegmentedDownloadOptions {
  url: string
  destination: string
  connections: number
  /** Bytes per second across the whole transfer, or 0 for unlimited. */
  bandwidthLimit?: number
  /**
   * The page this came from, so the request looks like the page's own.
   *
   * Optional because an ordinary file from an ordinary server needs none of it.
   * Absent for media it means a 403 — see `requestContext.ts`.
   */
  context?: MediaRequestContext
  onProgress: (receivedBytes: number, segments: readonly Segment[]) => void
}

/**
 * One file, downloaded over N connections and reassembled.
 *
 * Uses Electron's `net` module rather than Node's `http`, so requests go through
 * Chromium's stack — the same proxy resolution, certificate verification and
 * DNS the rest of the browser uses. A downloader that trusted a different TLS
 * stack from the browser would be a real security inconsistency, not a detail.
 *
 * **Segments are written straight into the destination file at their own
 * offsets** rather than into N temporary files that are concatenated at the end.
 * That halves the disk I/O and, more importantly, means a 4 GB download needs
 * 4 GB of disk rather than 8.
 *
 * Cancellation and pausing are cooperative: every request is tracked so it can
 * be aborted, and a paused transfer leaves the partial file and its segment
 * table intact so it can be continued later.
 */
export class SegmentedDownload {
  private aborted = false
  private paused = false
  private readonly requests = new Set<ReturnType<typeof net.request>>()
  private segments: Segment[] = []
  /**
   * Identity for the next segment work-stealing creates.
   *
   * Monotonic rather than `segments.length`, because a restored transfer starts
   * with segments whose indices were assigned in an earlier session - reusing
   * the length would hand two segments the same identity and make the progress
   * rows collide.
   */
  private nextSegmentIndex = 0
  private capabilities: ServerCapabilities | null = null
  /** Resolved after redirects — the URL segments are actually fetched from. */
  private effectiveUrl: string

  constructor(private readonly options: SegmentedDownloadOptions) {
    this.effectiveUrl = options.url
  }

  get serverCapabilities(): ServerCapabilities | null {
    return this.capabilities
  }

  get currentSegments(): readonly Segment[] {
    return this.segments
  }

  get receivedBytes(): number {
    return this.segments.reduce((total, segment) => total + segment.receivedBytes, 0)
  }

  /**
   * Asks the server what it can do, following redirects by hand.
   *
   * A ranged GET rather than a HEAD: many servers answer HEAD with no
   * `Accept-Ranges` and then happily serve ranges, and some CDNs reject HEAD
   * outright. Requesting `bytes=0-0` and looking for a 206 is the reliable
   * probe — it costs one byte.
   */
  async probe(): Promise<ServerCapabilities> {
    const { response, request, finalUrl } = await this.requestOnce(this.options.url, {
      Range: 'bytes=0-0'
    })
    this.effectiveUrl = finalUrl

    const capabilities = readCapabilities(response.headers, response.statusCode)
    // A 206 reports the *range* length in Content-Length; the real total is in
    // Content-Range. Missing that makes every segmented download think the file
    // is one byte long.
    const contentRange = headerValue(response.headers, 'content-range')
    const totalFromRange = contentRange ? Number(/\/(\d+)\s*$/.exec(contentRange)?.[1]) : Number.NaN
    const resolved: ServerCapabilities = {
      ...capabilities,
      totalBytes: Number.isFinite(totalFromRange) ? totalFromRange : capabilities.totalBytes
    }

    // Only the headers were wanted. Aborting the request is how a response is
    // discarded here — Electron's IncomingMessage has no `destroy`.
    this.discard(request)
    this.capabilities = resolved
    return resolved
  }

  /** Starts (or restarts) the transfer. Resolves when every segment is complete. */
  async run(totalBytes: number | null, connections: number): Promise<void> {
    this.aborted = false
    this.paused = false

    if (totalBytes === null || connections <= 1) {
      // Unknown length or a server that will not segment: one stream, appended
      // as it arrives. There is no offset to seek to because there is no map.
      this.segments = [{ index: 0, start: 0, end: (totalBytes ?? 0) - 1, receivedBytes: 0 }]
      await this.streamWhole()
      return
    }

    this.segments = planSegments(totalBytes, connections)
    this.nextSegmentIndex = this.segments.length
    // Preallocate so the filesystem can lay the file out contiguously and so a
    // sparse write at a high offset cannot fail late with ENOSPC.
    const handle = await fs.open(this.options.destination, 'w')
    try {
      await handle.truncate(totalBytes)
    } finally {
      await handle.close()
    }

    await this.drive(connections)
  }

  /**
   * Continues a partly-downloaded file.
   *
   * Refuses unless the server still proves the bytes are the same — see
   * `resumeIsSafe`. Resuming into a changed file produces a corrupt result that
   * looks complete, which is the worst failure this engine can have.
   */
  async resume(previous: ServerCapabilities, segments: Segment[]): Promise<{ resumed: boolean; reason: string }> {
    const now = await this.probe()
    const verdict = resumeIsSafe(previous, now)
    if (!verdict.safe) return { resumed: false, reason: verdict.reason }

    this.segments = segments.map((segment) => ({ ...segment }))
    this.aborted = false
    this.paused = false

    this.nextSegmentIndex = this.segments.reduce(
      (highest, segment) => Math.max(highest, segment.index + 1),
      0
    )

    // Through the same worker pool as a fresh run, and that matters more than
    // it looks: a transfer that was work-stolen before it was paused comes back
    // with far more segments than the connection limit. Fetching every
    // incomplete one - which is what this did - opened a connection per
    // segment, so resuming a download configured for 8 connections could hit
    // the server with thirty at once.
    await this.drive(this.options.connections)
    return { resumed: true, reason: verdict.reason }
  }

  pause(): void {
    this.paused = true
    this.abortAll()
  }

  cancel(): void {
    this.aborted = true
    this.abortAll()
  }

  /** SHA-256 of the finished file, for integrity checks where a digest is published. */
  async checksum(): Promise<string> {
    const hash = createHash('sha256')
    const handle = await fs.open(this.options.destination, 'r')
    try {
      const buffer = Buffer.alloc(1024 * 1024)
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }
    return hash.digest('hex')
  }

  /**
   * Runs the segment list over a fixed pool of connections.
   *
   * The pool is the point. Handing every segment its own connection - which is
   * what `Promise.all` over the segment array did - makes the download exactly
   * as fast as its slowest range: seven connections finish, go idle, and wait
   * for the eighth. Here a connection that runs out of work steals half of
   * whatever is furthest from done instead, so the transfer stays N-ways
   * parallel to the very end and no single slow range can hold it up.
   *
   * This is what a download manager means by dynamic segmentation, and it is
   * most of why one is faster than a browser's built-in download.
   */
  private async drive(connections: number): Promise<void> {
    const queue = this.segments.filter((segment) => !segmentIsComplete(segment))
    if (queue.length === 0) return

    const workers = Math.max(1, Math.min(Math.floor(connections), queue.length))
    await Promise.all(Array.from({ length: workers }, () => this.work(queue)))
  }

  /** One connection: take a segment, fetch it, then take or steal another. */
  private async work(queue: Segment[]): Promise<void> {
    for (;;) {
      if (this.aborted || this.paused) return
      const next = queue.shift() ?? this.steal()
      // Nothing queued and nothing left large enough to divide: this connection
      // is genuinely finished, and the pool drains one worker at a time.
      if (!next) return
      await this.fetchSegment(next)
    }
  }

  /**
   * Cuts the least-finished segment in half and claims the tail.
   *
   * Synchronous from the read of `segments` to the write of the donor's new
   * `end`, and that is load-bearing rather than incidental: the donor is
   * streaming, so its `receivedBytes` moves between ticks. Doing the arithmetic
   * and shrinking the donor in the same tick means the donor cannot have
   * written past the boundary by the time the boundary exists. The arithmetic
   * itself is in `planSplit`, where it is tested against the coverage
   * invariant - a gap or an overlap here produces a file that reaches 100%,
   * opens, and is corrupt in the middle.
   */
  private steal(): Segment | null {
    const plan = planSplit(this.segments, this.nextSegmentIndex)
    if (!plan) return null

    this.segments[plan.donorPosition]!.end = plan.donorNewEnd
    this.nextSegmentIndex += 1
    this.segments.push(plan.fresh)
    return plan.fresh
  }

  /**
   * One segment, written at its own offset in the destination file.
   *
   * Retries itself rather than failing the transfer. A single connection dying
   * on a long download is ordinary - a CDN node drops it, a proxy times out -
   * and letting that reject the whole run threw away every other connection's
   * progress to start the file again from zero. Only failures `classifyFailure`
   * calls retryable are retried; a 403 still fails at once, because trying it
   * three more times is how an address gets rate-limited.
   */
  private async fetchSegment(segment: Segment): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.fetchSegmentOnce(segment)
        return
      } catch (error) {
        if (this.aborted || this.paused) return
        const verdict = classifyFailure(error)
        if (!verdict.retryable || attempt >= SEGMENT_ATTEMPTS) throw error
        log.debug(`segment ${segment.index} failed (attempt ${attempt}): ${verdict.reason}`)
        await delay(Math.min(SEGMENT_RETRY_BASE_MS * attempt, SEGMENT_RETRY_CAP_MS))
        if (this.aborted || this.paused) return
      }
    }
  }

  private async fetchSegmentOnce(segment: Segment): Promise<void> {
    const from = segment.start + segment.receivedBytes
    if (from > segment.end) return

    const { response, request } = await this.requestOnce(this.effectiveUrl, {
      Range: `bytes=${from}-${segment.end}`
    })

    if (response.statusCode !== 206) {
      const retryAfter = headerValue(response.headers, 'retry-after')
      this.discard(request)
      throw describeFailure(
        `Server ignored the range request for segment ${segment.index} (status ${response.statusCode})`,
        response.statusCode,
        retryAfter
      )
    }

    const handle = await fs.open(this.options.destination, 'r+')
    let surrendered = false
    try {
      let offset = from
      for await (const chunk of response as unknown as AsyncIterable<Buffer>) {
        if (this.aborted || this.paused) break

        // `segment.end` moves. An idle connection may have taken this segment's
        // tail while this response was in flight, so the range being streamed is
        // now longer than the range still owned. Write only what is still ours
        // and stop - the thief is already fetching the rest, and writing past
        // the boundary would put the same bytes down twice from two connections
        // at once.
        const room = segment.end - offset + 1
        if (room <= 0) {
          surrendered = true
          break
        }
        const usable = chunk.length > room ? chunk.subarray(0, room) : chunk

        await handle.write(usable, 0, usable.length, offset)
        offset += usable.length
        segment.receivedBytes += usable.length
        this.options.onProgress(this.receivedBytes, this.segments)

        if (usable.length < chunk.length) {
          surrendered = true
          break
        }
        await this.throttle(usable.length)
      }
    } finally {
      await handle.close()
      // Stopping early leaves the server streaming a range nobody will read.
      // Abort it rather than letting it drain - those are bytes off the same
      // bandwidth the rest of the transfer is competing for.
      if (surrendered || this.aborted || this.paused) this.discard(request)
    }
  }

  /** The unsegmented path: one response streamed to disk in order. */
  private async streamWhole(): Promise<void> {
    const { response } = await this.requestOnce(this.effectiveUrl, {})
    const file = createWriteStream(this.options.destination)
    const segment = this.segments[0]!

    try {
      for await (const chunk of response as unknown as AsyncIterable<Buffer>) {
        if (this.aborted || this.paused) break
        if (!file.write(chunk)) {
          // Respect backpressure, or a fast server against a slow disk grows the
          // write buffer until the process runs out of memory.
          await new Promise<void>((resolve) => file.once('drain', resolve))
        }
        segment.receivedBytes += chunk.length
        this.options.onProgress(this.receivedBytes, this.segments)
        await this.throttle(chunk.length)
      }
    } finally {
      await new Promise<void>((resolve) => file.end(resolve))
    }
  }

  /**
   * A single request, whose redirects are followed and recorded.
   *
   * The hop chain matters — the download UI has to be able to show which host
   * actually served the bytes, which is what Redirect X-Ray and the Download
   * Guardian exist to surface — so the mode stays manual and `sendMediaRequest`
   * follows each hop by hand. This used to be a `statusCode >= 300` branch that
   * could never run: with `redirect: 'manual'` a 3xx never arrives as a
   * response, it arrives as a cancellation.
   */
  private async requestOnce(
    url: string,
    headers: Record<string, string>
  ): Promise<{
    response: Electron.IncomingMessage
    request: ReturnType<typeof net.request>
    finalUrl: string
  }> {
    const sent = await sendMediaRequest(url, this.options.context, headers, MAX_REDIRECTS)
    this.requests.add(sent.request)

    if (sent.response.statusCode >= 400) {
      this.discard(sent.request)
      throw new Error(`Server returned ${sent.response.statusCode}`)
    }
    return sent
  }

  /** Drops a response we are not going to read. */
  private discard(request: ReturnType<typeof net.request>): void {
    this.requests.delete(request)
    try {
      request.abort()
    } catch (error) {
      log.debug('discarding a response threw', error)
    }
  }

  /**
   * Holds the transfer to the configured ceiling.
   *
   * Deliberately crude — sleep proportional to what was just read. A token
   * bucket would be smoother, but this is a user-facing "don't saturate my
   * connection" control, not a traffic shaper, and being approximately right
   * with ten lines beats being exactly right with a hundred.
   */
  private async throttle(bytes: number): Promise<void> {
    const limit = this.options.bandwidthLimit ?? 0
    if (limit <= 0) return
    const seconds = bytes / limit
    if (seconds > 0.001) await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  }

  private abortAll(): void {
    for (const request of this.requests) {
      try {
        request.abort()
      } catch (error) {
        log.debug('aborting a download request threw', error)
      }
    }
    this.requests.clear()
  }
}

/** An error the retry policy can read: what the status was, and any Retry-After. */
export function describeFailure(
  message: string,
  status: number,
  retryAfter: string | null
): Error & { status: number; retryAfter: string | null } {
  const failure = new Error(message) as Error & { status: number; retryAfter: string | null }
  failure.status = status
  failure.retryAfter = retryAfter
  return failure
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    const first = Array.isArray(value) ? value[0] : value
    return first ?? null
  }
  return null
}
