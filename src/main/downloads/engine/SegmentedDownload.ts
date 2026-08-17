import { createWriteStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { net } from 'electron'
import type { Segment, ServerCapabilities } from '@shared/types/downloadEngine'
import { createLogger } from '../../logger'
import { planSegments, readCapabilities, resumeIsSafe } from './planning'

const log = createLogger('download')

/** Redirect hops before we assume a loop. */
const MAX_REDIRECTS = 10

export interface SegmentedDownloadOptions {
  url: string
  destination: string
  connections: number
  /** Bytes per second across the whole transfer, or 0 for unlimited. */
  bandwidthLimit?: number
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
    // Preallocate so the filesystem can lay the file out contiguously and so a
    // sparse write at a high offset cannot fail late with ENOSPC.
    const handle = await fs.open(this.options.destination, 'w')
    try {
      await handle.truncate(totalBytes)
    } finally {
      await handle.close()
    }

    await Promise.all(this.segments.map((segment) => this.fetchSegment(segment)))
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
    await Promise.all(
      this.segments
        .filter((segment) => segment.receivedBytes <= segment.end - segment.start)
        .map((segment) => this.fetchSegment(segment))
    )
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

  /** One segment, written at its own offset in the destination file. */
  private async fetchSegment(segment: Segment): Promise<void> {
    const from = segment.start + segment.receivedBytes
    if (from > segment.end) return

    const { response, request } = await this.requestOnce(this.effectiveUrl, {
      Range: `bytes=${from}-${segment.end}`
    })

    if (response.statusCode !== 206) {
      this.discard(request)
      throw new Error(
        `Server ignored the range request for segment ${segment.index} (status ${response.statusCode})`
      )
    }

    const handle = await fs.open(this.options.destination, 'r+')
    try {
      let offset = from
      for await (const chunk of response as unknown as AsyncIterable<Buffer>) {
        if (this.aborted || this.paused) break
        await handle.write(chunk, 0, chunk.length, offset)
        offset += chunk.length
        segment.receivedBytes += chunk.length
        this.options.onProgress(this.receivedBytes, this.segments)
        await this.throttle(chunk.length)
      }
    } finally {
      await handle.close()
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
   * A single request, following redirects manually.
   *
   * Manual because the destination after a redirect chain is something the
   * download UI has to be able to show — an automatic follow would hide which
   * host actually served the bytes, which is precisely what Redirect X-Ray and
   * the Download Guardian exist to surface.
   */
  private async requestOnce(
    url: string,
    headers: Record<string, string>,
    hop = 0
  ): Promise<{
    response: Electron.IncomingMessage
    request: ReturnType<typeof net.request>
    finalUrl: string
  }> {
    if (hop > MAX_REDIRECTS) throw new Error('Too many redirects')

    const request = net.request({ url, method: 'GET', redirect: 'manual' })
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
    this.requests.add(request)

    const response = await new Promise<Electron.IncomingMessage>((resolve, reject) => {
      request.on('response', resolve)
      request.on('error', reject)
      request.on('abort', () => reject(new Error('aborted')))
      request.end()
    })

    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = headerValue(response.headers, 'location')
      this.discard(request)
      if (!location) throw new Error(`Redirect with no location (status ${response.statusCode})`)
      return this.requestOnce(new URL(location, url).toString(), headers, hop + 1)
    }

    if (response.statusCode >= 400) {
      this.discard(request)
      throw new Error(`Server returned ${response.statusCode}`)
    }

    return { response, request, finalUrl: url }
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
