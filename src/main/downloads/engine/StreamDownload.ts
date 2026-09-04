import { createWriteStream, type WriteStream } from 'node:fs'
import type { net } from 'electron'
import {
  containerFor,
  estimateBytes,
  isMasterPlaylist,
  parseMaster,
  parseMedia,
  type HlsSegment,
  type HlsVariant
} from '../../media/hlsPlaylist'
import {
  looksLikeDash,
  parseMpd,
  qualityLabelFor,
  selectTracks,
  type DashRepresentation
} from '../../media/dash/mpdParser'
import { sendMediaRequest, type MediaRequestContext } from './requestContext'
import { limitMessage, MEDIA_LIMITS } from './limits'
import { describeFailure } from './SegmentedDownload'
import { createLogger } from '../../logger'

const log = createLogger('stream-dl')

/** Redirect chains on video CDNs are routinely three or four hops. */
const MAX_REDIRECTS = MEDIA_LIMITS.maxRedirects
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
  /**
   * A separate audio track to fetch and join, when the source keeps them apart.
   *
   * DASH always does above the lowest qualities: picture and sound are separate
   * representations so the player can drop one without interrupting the other.
   * Downloading only the video gets a silent film, so the queue fetches both
   * and hands them to the muxer — one entry in the list, one file at the end.
   */
  audio?: { segments: string[]; container: 'ts' | 'mp4'; optionalFrom?: number } | null
  /**
   * Index from which a missing segment ends the stream rather than failing it.
   *
   * Only a `SegmentTemplate` with a fixed duration needs this, and it is not a
   * fudge — the count really is an estimate. The spec says
   * `ceil(periodDuration / segmentDuration)`, and packagers round the other way
   * all the time: ffmpeg writing a twelve-second clip declared six segments and
   * produced one for the video (no keyframes to cut on) and seven for the audio
   * (AAC frames do not land on second boundaries).
   *
   * Under-count and the download is silently short; over-count and one 404 kills
   * the whole transfer. So the plan carries the estimate plus a short
   * look-ahead, and everything past this index may be absent. A gap *before* it
   * is still a failure, because that is a hole in the middle of a video.
   */
  optionalFrom?: number
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
/** One quality a master playlist offers, ready to be listed in the picker. */
export interface StreamQuality {
  readonly url: string
  /** "1920x1080", or null when the encoder did not say. */
  readonly resolution: string | null
  readonly bandwidth: number
}

/**
 * The qualities a stream offers, or none when it offers no choice.
 *
 * Separate from `planStream` because the picker asks a different question. The
 * downloader wants an ordered list of segments and will take the best variant
 * without asking; the picker wants to *show* the choice, and taking the best
 * silently is exactly the complaint — a 480p master and a 1080p master look
 * identical from outside, and neither offered a way to say which.
 *
 * Returns an empty list for a media playlist, which is not a failure: a stream
 * with one quality has nothing to choose between, and the caller offers it as
 * the single entry it already was.
 */
export async function readStreamVariants(
  manifestUrl: string,
  context?: MediaRequestContext
): Promise<StreamQuality[]> {
  const { url: address } = splitRepresentation(manifestUrl)

  let text: string
  try {
    text = await fetchText(address, context)
  } catch (error) {
    log.debug('could not read manifest for variants', error)
    return []
  }

  // DASH first, because the answer is in the document either way and only one
  // of the two parsers can make sense of it.
  if (looksLikeDash(text)) {
    const parsed = parseMpd(text, address)
    if (!parsed.ok) return []
    return parsed.manifest.video.slice(0, MEDIA_LIMITS.maxVariants).map((track) => ({
      // Every quality shares the manifest's address, so each row is identified
      // by a fragment naming its representation — see `representationFragment`.
      url: representationFragment(address, track.id),
      resolution: track.width !== null && track.height !== null ? `${track.width}x${track.height}` : null,
      bandwidth: track.bandwidth
    }))
  }

  if (!isMasterPlaylist(text)) return []
  return parseMaster(text, address)
    .slice(0, MEDIA_LIMITS.maxVariants)
    .map((variant: HlsVariant) => ({
      url: variant.url,
      resolution: variant.resolution,
      bandwidth: variant.bandwidth
    }))
}

/**
 * A DASH representation is chosen by id, and an id is not an address.
 *
 * Every quality in an MPD shares one manifest URL, so the picker needs
 * something distinct per row — the queue keys downloads by URL, and so does the
 * check that a chosen address was actually offered. A fragment is the honest
 * way to say it: it identifies a part of the resource, and browsers never send
 * one to a server, so nothing leaks into the request.
 */
export function representationFragment(manifestUrl: string, id: string): string {
  return `${manifestUrl.split('#')[0]}#rep=${encodeURIComponent(id)}`
}

/** Splits `…/manifest.mpd#rep=v720` back into an address and a choice. */
export function splitRepresentation(url: string): { url: string; representationId?: string } {
  const [address, fragment] = url.split('#')
  const match = fragment ? /^rep=(.*)$/.exec(fragment) : null
  return match?.[1] === undefined
    ? { url: address ?? url }
    : { url: address ?? url, representationId: decodeURIComponent(match[1]) }
}

/**
 * Plans whatever this address turns out to be.
 *
 * **The protocol is decided by what came back, not by the address.** A CDN
 * serving HLS from `/hls/1080/<hash>` with no extension is ordinary, and the
 * engine used to decide from the path and get it wrong. One fetch, then the
 * content says which parser to use.
 */
export async function planStream(
  manifestUrl: string,
  context?: MediaRequestContext,
  /**
   * What the manifest said about the chosen quality, when the caller already
   * read it. Only the size estimate depends on it — a variant playlist does not
   * carry its own bitrate, so a quality chosen from the picker would otherwise
   * lose the estimate the master could have supplied.
   */
  hint?: { bandwidth?: number; quality?: string | null }
): Promise<StreamPlanResult> {
  const { url: address, representationId } = splitRepresentation(manifestUrl)

  let text: string
  try {
    text = await fetchText(address, context)
  } catch (error) {
    log.warn('could not read manifest', error)
    return { ok: false, reason: 'This stream’s playlist could not be read.' }
  }

  if (looksLikeDash(text)) return planDash(text, address, representationId)
  return planHls(text, address, context, hint)
}

/**
 * MPEG-DASH: pick a video representation, pick the audio beside it, join later.
 *
 * Deliberately **not** routed through the HLS parser. The two describe the same
 * idea so differently that one reader for both is a branch on every line, and
 * an `.mpd` sent to `parseMedia` finds no `#EXTINF` and reports "this stream
 * lists no segments" — a refusal that names the wrong reason.
 */
function planDash(
  text: string,
  manifestUrl: string,
  representationId?: string
): StreamPlanResult {
  const parsed = parseMpd(text, manifestUrl)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }

  const { video, audio } = selectTracks(parsed.manifest, representationId)
  const primary = video ?? audio
  if (!primary) {
    return { ok: false, reason: 'This manifest lists no tracks Slash can download.' }
  }

  const listFor = (track: DashRepresentation): string[] => [
    // The initialisation segment is not optional and is not a segment: first it
    // makes the file playable, omitted it makes the download rubbish.
    ...(track.initSegment ? [track.initSegment] : []),
    ...track.segments
  ]

  // Only worth joining when there is a picture to join sound to. An audio-only
  // manifest is already one complete thing.
  const separateAudio = video && audio ? audio : null
  const bitrate = primary.bandwidth + (separateAudio?.bandwidth ?? 0)

  // Where the parser's certainty ends. The initialisation segment shifts every
  // index by one, and forgetting that would make the *last real* segment
  // optional — so a genuinely truncated download would report success.
  const optionalFrom =
    primary.certainSegments === null
      ? undefined
      : primary.certainSegments + (primary.initSegment ? 1 : 0)

  return {
    ok: true,
    plan: {
      segments: listFor(primary),
      estimatedBytes: estimateBytes(bitrate, parsed.manifest.durationSeconds),
      // DASH segments are fragmented MP4 whether or not the extension says so.
      container: 'mp4',
      quality: video ? qualityLabelFor(video) : 'Audio only',
      audio: separateAudio
        ? {
            segments: listFor(separateAudio),
            container: 'mp4' as const,
            // The audio track has its own estimate, and it is usually the one
            // that runs long: AAC frames do not land on second boundaries, so
            // a packager writes a seventh segment for a six-segment manifest.
            ...(separateAudio.certainSegments === null
              ? {}
              : {
                  optionalFrom:
                    separateAudio.certainSegments + (separateAudio.initSegment ? 1 : 0)
                })
          }
        : null,
      ...(optionalFrom === undefined ? {} : { optionalFrom })
    }
  }
}

/** HLS: a master playlist chooses a variant, then that variant lists segments. */
async function planHls(
  text: string,
  manifestUrl: string,
  context: MediaRequestContext | undefined,
  hint: { bandwidth?: number; quality?: string | null } | undefined
): Promise<StreamPlanResult> {

  let mediaUrl = manifestUrl
  let bandwidth = hint?.bandwidth ?? 0
  let quality: string | null = hint?.quality ?? null

  if (isMasterPlaylist(text)) {
    const variants = parseMaster(text, manifestUrl)
    if (variants.length > MEDIA_LIMITS.maxVariants) {
      return { ok: false, reason: limitMessage('maxVariants') }
    }
    const best = variants[0]
    if (!best) return { ok: false, reason: 'This stream lists no qualities to download.' }

    mediaUrl = best.url
    bandwidth = best.bandwidth
    quality = best.resolution
    try {
      text = await fetchText(best.url, context)
    } catch {
      return { ok: false, reason: 'This stream’s playlist could not be read.' }
    }
  }

  const media = parseMedia(text, mediaUrl)
  if (media.refusal) return { ok: false, reason: media.refusal }
  if (media.segments.length > MEDIA_LIMITS.maxSegments) {
    return { ok: false, reason: limitMessage('maxSegments') }
  }

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
      /** The page the stream belongs to. Its segments are hotlink-protected too. */
      context?: MediaRequestContext
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
    /** First absent optional segment. Everything from here on is discarded. */
    let missingTail = Number.POSITIVE_INFINITY
    const holding = new Map<number, Buffer>()

    /** Writes everything now contiguous from `nextToWrite`. */
    const drain = async (): Promise<void> => {
      while (holding.has(nextToWrite)) {
        const chunk = holding.get(nextToWrite)
        holding.delete(nextToWrite)
        if (!chunk) break
        // Once the stream has ended, nothing after that point belongs in the
        // file — a later segment that happens to exist would be spliced on
        // after a gap and corrupt everything from there.
        if (nextToWrite >= missingTail) {
          nextToWrite += 1
          continue
        }
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
          try {
            const bytes = await this.fetchSegment(plan.segments[index] ?? '')
            holding.set(index, bytes)
            done += 1
            onProgress(written + bytes.length, done, plan.segments.length)
          } catch (error) {
            // Past the estimate, an absent segment means the stream ended
            // sooner than the manifest implied — which is ordinary. Before it,
            // it is a hole in the middle of a video and must fail.
            const optionalFrom = plan.optionalFrom ?? plan.segments.length
            log.debug(
              `segment ${index} failed: status=${(error as { status?: number }).status ?? '?'} ` +
                `optionalFrom=${optionalFrom} of ${plan.segments.length} url=${plan.segments[index]}`
            )
            if (index < optionalFrom || !isMissing(error)) throw error
            missingTail = Math.min(missingTail, index)
            holding.set(index, Buffer.alloc(0))
            done += 1
          }
        })()
        inFlight.add(task)
        // `.finally()` returns a *new* promise that rejects with the same
        // reason, and nothing was awaiting it. With four segments in flight,
        // one genuine failure surfaced through `Promise.race` and the other
        // three became unhandled rejections — pages of `unhandled rejection in
        // main` for a single 404, drowning the log the failure had to be
        // diagnosed from. Attaching a no-op catch marks them handled; the real
        // error still reaches `run` through the race below.
        void task.finally(() => inFlight.delete(task)).catch(() => {})
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
    const assembled = Number.isFinite(missingTail) ? missingTail : plan.segments.length
    log.info(
      `assembled ${assembled} segments into ${destination}` +
        (Number.isFinite(missingTail)
          ? ` (the manifest over-declared; it ended at segment ${assembled})`
          : '')
    )
  }

  private async fetchSegment(url: string): Promise<Buffer> {
    if (url === '') return Buffer.alloc(0)
    const { response, request } = await this.requestOnce(url)

    return await new Promise<Buffer>((resolve, reject) => {
      const parts: Buffer[] = []
      let held = 0
      response.on('data', (chunk: Buffer) => {
        held += chunk.length
        // Segments are buffered until their turn, because they must be written
        // in order. A server answering one with an endless body would otherwise
        // grow this process until it died.
        if (held > MEDIA_LIMITS.maxSegmentBytes) {
          this.requests.delete(request)
          reject(new Error(limitMessage('maxSegmentBytes')))
          return
        }
        parts.push(chunk)
      })
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
    url: string
  ): Promise<{ response: Electron.IncomingMessage; request: ReturnType<typeof net.request> }> {
    const sent = await sendMediaRequest(url, this.options.context, {}, MAX_REDIRECTS)
    this.requests.add(sent.request)

    if (sent.response.statusCode >= 400) {
      const retryAfter = headerOf(sent.response.headers, 'retry-after')
      this.requests.delete(sent.request)
      throw describeFailure(
        `Segment refused with ${sent.response.statusCode}`,
        sent.response.statusCode,
        retryAfter
      )
    }
    return { response: sent.response, request: sent.request }
  }
}

/**
 * Whether a segment failed because it is not there, rather than for any reason.
 *
 * The tolerance for a short stream must be about **absence** specifically. A
 * 403, a 500 or a dropped connection on a trailing segment is a transfer that
 * went wrong, and quietly finishing early on one of those would hand somebody a
 * truncated video reported as complete.
 */
function isMissing(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status
  return status === 404 || status === 410
}

/** One response header by name, whatever case the server chose. */
function headerOf(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    const first = Array.isArray(value) ? value[0] : value
    return first ?? null
  }
  return null
}

function writeChunk(file: WriteStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    file.write(chunk, (error) => (error ? reject(error) : resolve()))
  })
}

async function fetchText(url: string, context?: MediaRequestContext): Promise<string> {
  const { response } = await sendMediaRequest(url, context, {}, MAX_REDIRECTS)
  if (response.statusCode >= 400) throw new Error(`Playlist refused with ${response.statusCode}`)

  return await new Promise<string>((resolve, reject) => {
    const parts: Buffer[] = []
    let held = 0
    response.on('data', (chunk: Buffer) => {
      held += chunk.length
      // A manifest is a file fetched from a page the user merely visited. A
      // two-hour playlist is a few hundred kilobytes; anything near this cap is
      // not a playlist.
      if (held > MEDIA_LIMITS.maxManifestBytes) {
        reject(new Error(limitMessage('maxManifestBytes')))
        return
      }
      parts.push(chunk)
    })
    response.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    response.on('error', reject)
  })
}
