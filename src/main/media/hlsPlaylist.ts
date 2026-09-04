/**
 * Reading HLS playlists — the format most streamed video on the web arrives in.
 *
 * A stream is not a file. `master.m3u8` lists quality variants; each variant is
 * another playlist listing hundreds or thousands of short segments; the video is
 * those segments in order. Nothing in that chain is downloadable on its own,
 * which is why the browser used to refuse the lot with a sentence about adaptive
 * delivery.
 *
 * It can be assembled. Segments concatenated in order are a playable file for
 * both shapes HLS uses — MPEG-TS directly, and fragmented MP4 provided the
 * initialisation segment named by `#EXT-X-MAP` goes first. No re-encoding, no
 * decoding: bytes in order.
 *
 * **Encrypted variants are refused, not decrypted.** `#EXT-X-KEY` with anything
 * but `NONE` means the segments are ciphered, and fetching the key to unpick
 * them is the line this browser does not cross. They are recognised so the
 * refusal can name the reason.
 *
 * Pure, and tested against the shapes real servers actually emit — absolute and
 * relative URIs, byte-range segments, live playlists with no end, and the
 * attribute quoting that varies by encoder.
 */

export interface HlsVariant {
  /** Absolute URL of the variant's own playlist. */
  readonly url: string
  /** Bits per second the encoder declared. The ranking key. */
  readonly bandwidth: number
  /** "1920x1080", when declared. */
  readonly resolution: string | null
  readonly codecs: string
}

export interface HlsSegment {
  readonly url: string
  /** Seconds, from `#EXTINF`. Used only to estimate total size. */
  readonly duration: number
  /** `#EXT-X-BYTERANGE`, when the segment is a slice of a larger file. */
  readonly byteRange: { length: number; offset: number } | null
}

export interface HlsMedia {
  /** `#EXT-X-MAP` — must be written first or a fragmented MP4 will not play. */
  readonly initSegment: string | null
  readonly segments: HlsSegment[]
  /** Total of every `#EXTINF`, in seconds. */
  readonly durationSeconds: number
  /**
   * Why this cannot be downloaded, if it cannot.
   *
   * Encryption and live streams both end up here. A live playlist has no end —
   * downloading it means choosing a moment to stop, which is a recording
   * feature and a different thing from saving a video.
   */
  readonly refusal: string | null
}

const isUri = (line: string): boolean => line !== '' && !line.startsWith('#')

/** Resolves a playlist line against the playlist's own address. */
export function resolveUri(uri: string, base: string): string {
  try {
    return new URL(uri, base).toString()
  } catch {
    return uri
  }
}

/**
 * Attribute lists, which are not quite CSV.
 *
 * `BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720` — the
 * comma inside the quoted CODECS value is not a separator, and splitting on
 * commas is the mistake that makes every variant's codec list wrong.
 */
export function parseAttributes(line: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line)) !== null) {
    const key = match[1]
    if (key === undefined) continue
    attributes[key] = match[3] !== undefined ? match[3] : (match[2] ?? '')
  }
  return attributes
}

/** True when this is a master playlist listing variants rather than segments. */
export function isMasterPlaylist(text: string): boolean {
  return text.includes('#EXT-X-STREAM-INF')
}

/** Every quality on offer, best first. */
export function parseMaster(text: string, playlistUrl: string): HlsVariant[] {
  const lines = text.split(/\r?\n/)
  const variants: HlsVariant[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue

    // The URI is the next line that is not a comment. Encoders put blank lines
    // and unrelated tags between the two more often than the spec suggests.
    let uri = ''
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next]?.trim() ?? ''
      if (isUri(candidate)) {
        uri = candidate
        break
      }
    }
    if (uri === '') continue

    const attributes = parseAttributes(line)
    variants.push({
      url: resolveUri(uri, playlistUrl),
      bandwidth: Number(attributes['BANDWIDTH'] ?? attributes['AVERAGE-BANDWIDTH'] ?? 0) || 0,
      resolution: attributes['RESOLUTION'] ?? null,
      codecs: attributes['CODECS'] ?? ''
    })
  }

  return variants.sort((a, b) => b.bandwidth - a.bandwidth)
}

/** The segments of one variant, or a refusal saying why not. */
export function parseMedia(text: string, playlistUrl: string): HlsMedia {
  const lines = text.split(/\r?\n/)
  const segments: HlsSegment[] = []

  let initSegment: string | null = null
  let duration = 0
  let pendingDuration = 0
  let pendingRange: HlsSegment['byteRange'] = null
  let encrypted = false
  let ended = false
  let sawTarget = false

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue

    if (line.startsWith('#EXT-X-KEY')) {
      const method = parseAttributes(line)['METHOD'] ?? 'NONE'
      if (method.toUpperCase() !== 'NONE') encrypted = true
      continue
    }
    if (line.startsWith('#EXT-X-MAP')) {
      const uri = parseAttributes(line)['URI']
      if (uri) initSegment = resolveUri(uri, playlistUrl)
      continue
    }
    if (line.startsWith('#EXT-X-ENDLIST')) {
      ended = true
      continue
    }
    if (line.startsWith('#EXT-X-TARGETDURATION')) {
      sawTarget = true
      continue
    }
    if (line.startsWith('#EXTINF')) {
      pendingDuration = Number(line.slice(8).split(',')[0]) || 0
      continue
    }
    if (line.startsWith('#EXT-X-BYTERANGE')) {
      const [length, offset] = line.slice(17).split('@')
      pendingRange = { length: Number(length) || 0, offset: Number(offset ?? 0) || 0 }
      continue
    }
    if (!isUri(line)) continue

    segments.push({
      url: resolveUri(line, playlistUrl),
      duration: pendingDuration,
      byteRange: pendingRange
    })
    duration += pendingDuration
    pendingDuration = 0
    pendingRange = null
  }

  return {
    initSegment,
    segments,
    durationSeconds: duration,
    refusal: refusalFor({ encrypted, ended, sawTarget, count: segments.length })
  }
}

function refusalFor(state: {
  encrypted: boolean
  ended: boolean
  sawTarget: boolean
  count: number
}): string | null {
  if (state.encrypted) {
    return (
      'This stream is encrypted. Slash does not unpick a site’s encryption to download its ' +
      'video, so there is nothing here it can save.'
    )
  }
  if (state.count === 0) return 'This stream lists no segments.'
  if (!state.ended && state.sawTarget) {
    // A live playlist grows. "Download" would mean choosing a moment to stop,
    // which is recording — a different feature with different expectations, and
    // one that should not happen by pressing a button labelled Download.
    return 'This is a live stream, which has no end to download. Try again once it has finished.'
  }
  return null
}

/**
 * Roughly how big the finished file will be.
 *
 * From the declared bandwidth and total duration, because segment sizes are not
 * in the playlist and asking the server for each one means thousands of
 * requests before anything is offered. Labelled as approximate wherever shown —
 * it is usually within a few percent and occasionally is not.
 */
export function estimateBytes(bandwidthBitsPerSecond: number, durationSeconds: number): number | null {
  if (bandwidthBitsPerSecond <= 0 || durationSeconds <= 0) return null
  return Math.round((bandwidthBitsPerSecond / 8) * durationSeconds)
}

/**
 * Whether concatenating these segments produces a playable file, and as what.
 *
 * MPEG-TS concatenates directly. Fragmented MP4 needs its `#EXT-X-MAP` init
 * segment first and then concatenates. Anything else is refused rather than
 * guessed at, because the failure is a file that downloads perfectly and will
 * not open.
 */
export function containerFor(segments: readonly HlsSegment[], hasInit: boolean): 'ts' | 'mp4' | null {
  const first = segments[0]?.url ?? ''
  const path = first.split('?')[0]?.toLowerCase() ?? ''

  if (path.endsWith('.ts')) return 'ts'
  if (path.endsWith('.m4s') || path.endsWith('.mp4') || path.endsWith('.cmfv')) {
    return hasInit ? 'mp4' : null
  }
  // No extension at all is common on CDNs that route by query string. An init
  // segment is the reliable signal that this is fragmented MP4.
  if (hasInit) return 'mp4'
  return path === '' ? null : 'ts'
}
