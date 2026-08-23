import { createWriteStream, type WriteStream } from 'node:fs'
import { net } from 'electron'
import {
  containerFor,
  estimateBytes,
  isMasterPlaylist,
  parseMaster,
  parseMedia,
  type HlsSegment
} from '../../media/hlsPlaylist'
import { createLogger } from '../../logger'

const log = createLogger('stream-dl')

/** Redirect chains on video CDNs are routinely three or four hops. */
const MAX_REDIRECTS = 8
/**
 * Segments fetched at once.
 *
 * They must be *written* in order, so parallelism means holding finished
 * segments in memory until their turn. Four is enough to keep a fast link busy
 * while capping that buffer at a few tens of megabytes; higher numbers buy
 * little and risk the server treating it as abuse.
 */
const CONCURRENCY = 4

export interface StreamPlan {
  /** Every segment, in the order they must be written. */
  segments: string[]
  /** Bytes, roughly, from the declared bitrate. Never exact. */
  estimatedBytes: number | null
  container: 'ts' | 'mp4'
  /** Resolution of the variant chosen, for the UI. */
  quality: string | null
}

export type StreamPlanResult = { ok: true; plan: StreamPlan } | { ok: false; reason: string }

/**
 * Turns an HLS playlist into an ordered list of segments, or a refusal.
 *
 * Two fetches at most: the master playlist, then the chosen variant's. Nothing
 * is downloaded to decide — a stream's own numbers are enough to plan, and
 * asking the server for thousands of segment sizes before offering a button
 * would take longer than the download.
 */
export async function planStream(manifestUrl: string): Promise<StreamPlanResult> {
  let text: string
  try {
    text = await fetchText(manifestUrl)
  } catch (error) {
    log.warn('could not read playlist', error)
    return { ok: false, reason: 'This stream’s playlist could not be read.' }
  }

  let mediaUrl = manifestUrl
  let bandwidth = 0
  let quality: string | null = null

  if (isMasterPlaylist(text)) {
    const variants = parseMaster(text, manifestUrl)
    const best = variants[0]
    if (!best) return { ok: false, reason: 'This stream lists no qualities to download.' }

    mediaUrl = best.url
    bandwidth = best.bandwidth
    quality = best.resolution
    try {
      text = await fetchText(best.url)
    } catch {
      return { ok: false, reason: 'This stream’s playlist could not be read.' }
    }
  }

  const media = parseMedia(text, mediaUrl)
  if (media.refusal) return { ok: false, reason: media.refusal }

  const container = containerFor(media.segments, media.initSegment !== null)
  if (!container) {
    // Concatenating an unrecognised shape gives a file that downloads perfectly
    // and will not open, which is worse than saying no.
    return {
      ok: false,
      reason: 'This stream is in a shape Slash cannot join into a playable file.'
    }
  }

  return {
    ok: true,
    plan: {
      // The initialisation segment is not optional and is not a segment: put
      // first it makes the file playable, omitted it makes it rubbish.
      segments: [
        ...(media.initSegment ? [media.initSegment] : []),
        ...media.segments.map((segment: HlsSegment) => segment.url)
      ],
      estimatedBytes: estimateBytes(bandwidth, media.durationSeconds),
      container,
      quality
    }
  }
}

/**
 * Downloads a planned stream into one file.
 *
 * Segments are fetched a few at a time and **written strictly in order**, which
 * is the whole correctness requirement: a video is its segments in sequence, and
 * one written out of turn corrupts everything after it. Finished segments wait
 * in memory for their turn rather than being written where they land.
 *
 * No re-encoding and no decoding — the bytes go to disk as they arrive. That is
 * what makes this fast and what keeps it honest: nothing here understands the
 * video, so nothing here can be made to unpick one that is protected.
 */
export class StreamDownload {
  private cancelled = false
  private readonly requests = new Set<ReturnType<typeof net.request>>()

  constructor(
    private readonly options: {
      plan: StreamPlan
      destination: string
      onProgress: (bytesWritten: number, segmentsDone: number, segmentsTotal: number) => void
    }
  ) {}

  cancel(): void {
    this.cancelled = true
    for (const request of this.requests) {
      try {
        request.abort()
      } catch {
        // Already finished. Nothing to stop.
      }
    }
    this.requests.clear()
  }

  async run(): Promise<void> {
    const { plan, destination, onProgress } = this.options
    const file = createWriteStream(destination)

    let written = 0
    let nextToWrite = 0
    let done = 0
    const holding = new Map<number, Buffer>()

    /** Writes everything now contiguous from `nextToWrite`. */
    const drain = async (): Promise<void> => {
      while (holding.has(nextToWrite)) {
        const chunk = holding.get(nextToWrite)
        holding.delete(nextToWrite)
        if (!chunk) break
        await writeChunk(file, chunk)
        written += chunk.length
        nextToWrite += 1
      }
    }

    try {
      let cursor = 0
      const inFlight = new Set<Promise<void>>()

      const start = (index: number): void => {
        const task = (async () => {
          const bytes = await this.fetchSegment(plan.segments[index] ?? '')
          holding.set(index, bytes)
          done += 1
          onProgress(written + bytes.length, done, plan.segments.length)
        })()
        inFlight.add(task)
        void task.finally(() => inFlight.delete(task))
      }

      while (cursor < plan.segments.length || inFlight.size > 0) {
        if (this.cancelled) throw new Error('cancelled')

        while (cursor < plan.segments.length && inFlight.size < CONCURRENCY) {
          start(cursor)
          cursor += 1
        }

        await Promise.race(inFlight.size > 0 ? [...inFlight] : [Promise.resolve()])
        await drain()
      }

      await drain()
    } finally {
      await new Promise<void>((resolve) => file.end(resolve))
    }

    if (this.cancelled) throw new Error('cancelled')
    log.info(`assembled ${plan.segments.length} segments into ${destination}`)
  }

  private async fetchSegment(url: string): Promise<Buffer> {
    if (url === '') return Buffer.alloc(0)
    const { response, request } = await this.requestOnce(url, 0)

    return await new Promise<Buffer>((resolve, reject) => {
      const parts: Buffer[] = []
      response.on('data', (chunk: Buffer) => parts.push(chunk))
      response.on('end', () => {
        this.requests.delete(request)
        resolve(Buffer.concat(parts))
      })
      response.on('error', (error: Error) => {
        this.requests.delete(request)
        reject(error)
      })
    })
  }

  private async requestOnce(
    url: string,
    hop: number
  ): Promise<{ response: Electron.IncomingMessage; request: ReturnType<typeof net.request> }> {
    if (hop > MAX_REDIRECTS) throw new Error('Too many redirects')

    const request = net.request({ url, method: 'GET', redirect: 'manual' })
    this.requests.add(request)

    const response = await new Promise<Electron.IncomingMessage>((resolve, reject) => {
      request.on('response', resolve)
      request.on('error', reject)
      request.on('abort', () => reject(new Error('aborted')))
      request.end()
    })

    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = response.headers['location']
      const target = Array.isArray(location) ? location[0] : location
      this.requests.delete(request)
      if (!target) throw new Error(`Redirect with no location (${response.statusCode})`)
      return this.requestOnce(new URL(target, url).toString(), hop + 1)
    }
    if (response.statusCode >= 400) {
      this.requests.delete(request)
      throw new Error(`Segment refused with ${response.statusCode}`)
    }

    return { response, request }
  }
}

function writeChunk(file: WriteStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    file.write(chunk, (error) => (error ? reject(error) : resolve()))
  })
}

async function fetchText(url: string): Promise<string> {
  const request = net.request({ url, method: 'GET' })
  const response = await new Promise<Electron.IncomingMessage>((resolve, reject) => {
    request.on('response', resolve)
    request.on('error', reject)
    request.end()
  })
  if (response.statusCode >= 400) throw new Error(`Playlist refused with ${response.statusCode}`)

  return await new Promise<string>((resolve, reject) => {
    const parts: Buffer[] = []
    response.on('data', (chunk: Buffer) => parts.push(chunk))
    response.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    response.on('error', reject)
  })
}
