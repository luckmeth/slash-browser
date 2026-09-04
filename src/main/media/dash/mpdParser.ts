import { childNamed, childrenNamed, parseXml, type XmlNode } from './xml'

/**
 * Reading MPEG-DASH manifests — the other half of adaptive streaming.
 *
 * HLS is a text playlist; DASH is the same idea in XML, and the two are not
 * close enough to share a parser. `#EXTINF` and `<SegmentTemplate>` describe
 * the same thing so differently that a single reader for both would be a
 * branch on every line. So this is separate, pure, and tested against the
 * shapes real packagers emit.
 *
 * ## What is supported, and what is refused with a reason
 *
 * **Supported:** on-demand (`type="static"`), `SegmentTemplate` with and
 * without `SegmentTimeline`, `SegmentList`, `SegmentBase` (a single indexed
 * file), several video qualities, several audio tracks, and the four-level
 * `BaseURL` inheritance the spec allows.
 *
 * **Refused, and *said*:** live (`type="dynamic"`) has no end, so downloading
 * one means choosing a moment to stop — that is recording, a different feature.
 * Multi-period manifests splice several presentations together and need
 * concatenation rules this does not implement. Encrypted representations
 * (`ContentProtection`) are recognised **in order to be excluded**, never
 * decrypted.
 *
 * A refusal names which of those applies. "Nothing to download" for a live
 * stream sends somebody off to check whether the feature is broken.
 */

export type DashTrackKind = 'video' | 'audio' | 'text' | 'other'

export interface DashRepresentation {
  readonly id: string
  readonly kind: DashTrackKind
  readonly mimeType: string
  readonly codecs: string
  /** Bits per second the packager declared. The ranking key. */
  readonly bandwidth: number
  readonly width: number | null
  readonly height: number | null
  readonly lang: string | null
  /** `Initialization` — must be written first or the file will not play. */
  readonly initSegment: string | null
  /** Every media segment, in the order they must be written. */
  readonly segments: string[]
  /**
   * How many of those are certain, when the rest are a look-ahead.
   *
   * A `SegmentTemplate` with a fixed duration gives a *count*, not a list, and
   * the count is `ceil(periodDuration / segmentDuration)` — an estimate that
   * packagers land either side of. Segments past this index may simply not
   * exist, and the downloader treats their absence as the end of the stream
   * rather than as a failure. Null when the manifest listed segments explicitly
   * and there is nothing to estimate.
   */
  readonly certainSegments: number | null
}

export type DashManifest = {
  readonly durationSeconds: number
  readonly video: DashRepresentation[]
  readonly audio: DashRepresentation[]
}

export type DashResult = { ok: true; manifest: DashManifest } | { ok: false; reason: string }

/**
 * Extra segments planned past a template's declared count.
 *
 * Packagers write one or two more than they declare — AAC frames do not land on
 * second boundaries — and stopping at the declared number silently truncates
 * the audio. Each look-ahead segment is one request that either exists or ends
 * the stream, so five is cheap insurance.
 */
const SEGMENT_LOOK_AHEAD = 5

/** Caps that stop a hostile manifest from planning millions of requests. */
export const DASH_LIMITS = {
  /** Segments in one representation. Two hours of two-second segments is 3600. */
  maxSegments: 20_000,
  /** Representations across the whole manifest. */
  maxRepresentations: 200
} as const

/** True when this document is a DASH manifest rather than something else. */
export function looksLikeDash(source: string): boolean {
  return /<MPD[\s>]/i.test(source) || /urn:mpeg:dash:schema:mpd/i.test(source)
}

/**
 * `PT1H23M12.5S` → seconds.
 *
 * ISO 8601 durations, restricted to what a manifest actually uses. Returns 0
 * for anything unparseable, which the caller treats as "the length is unknown"
 * rather than "the video is zero seconds long".
 */
export function parseDuration(raw: string | undefined): number {
  if (!raw) return 0
  const match = /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(
    raw.trim()
  )
  if (!match) return 0
  const [, years, months, days, hours, minutes, seconds] = match
  const value =
    Number(years ?? 0) * 31_536_000 +
    Number(months ?? 0) * 2_592_000 +
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  return Number.isFinite(value) ? value : 0
}

/** Resolves a manifest-relative address, keeping an absolute one as it is. */
export function resolveUrl(reference: string, base: string): string {
  try {
    return new URL(reference, base).toString()
  } catch {
    return reference
  }
}

/**
 * The address to resolve against at this level of the document.
 *
 * `BaseURL` may appear on MPD, Period, AdaptationSet and Representation, and
 * each one is resolved against the one above it. Getting this wrong produces
 * segment URLs that are individually well-formed and collectively point at
 * nothing.
 */
function baseFor(node: XmlNode, inherited: string): string {
  const declared = childNamed(node, 'BaseURL')?.text.trim()
  return declared && declared !== '' ? resolveUrl(declared, inherited) : inherited
}

const num = (raw: string | undefined): number | null => {
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * `$Number%05d$` and friends.
 *
 * The identifiers a `SegmentTemplate` substitutes, including the printf-style
 * width that some packagers use and many parsers forget — omit it and every
 * segment address is off by the leading zeros.
 */
export function fillTemplate(
  template: string,
  values: { representationId: string; bandwidth: number; number?: number; time?: number }
): string {
  // `$$` is a two-character escape, not an identifier — it has no closing `$`.
  // Matching it inside the identifier pattern silently left `a$$b` untouched.
  return template.replace(/\$\$|\$([A-Za-z]+)(%0(\d+)d)?\$/g, (whole, name?: string, _fmt?: string, width?: string) => {
    if (whole === '$$') return '$'
    if (name === undefined) return whole
    const pad = (value: number): string =>
      width === undefined ? String(value) : String(value).padStart(Number(width), '0')

    switch (name) {
      case 'RepresentationID':
        return values.representationId
      case 'Bandwidth':
        return pad(values.bandwidth)
      case 'Number':
        return values.number === undefined ? whole : pad(values.number)
      case 'Time':
        return values.time === undefined ? whole : pad(values.time)
      default:
        return whole
    }
  })
}

/** `<SegmentTimeline>` → the start time of every segment, in timescale units. */
export function expandTimeline(timeline: XmlNode, cap: number): number[] {
  const times: number[] = []
  let cursor = 0
  for (const entry of childrenNamed(timeline, 'S')) {
    const start = num(entry.attributes['t'])
    const duration = num(entry.attributes['d']) ?? 0
    // `r` is the number of *additional* repeats. `r="-1"` means "until the end
    // of the period", which needs a period length this function does not have —
    // treated as one segment rather than guessed at.
    const repeats = Math.max(0, num(entry.attributes['r']) ?? 0)
    if (start !== null) cursor = start
    for (let index = 0; index <= repeats; index += 1) {
      if (times.length >= cap) return times
      times.push(cursor)
      cursor += duration
    }
  }
  return times
}

/** Every segment address for one representation, in play order. */
function segmentsFor(
  representation: XmlNode,
  parents: readonly XmlNode[],
  base: string,
  id: string,
  bandwidth: number,
  periodSeconds: number
): { init: string | null; segments: string[]; certain: number | null } {
  // Each of these may be declared on the Representation or inherited from the
  // AdaptationSet or the Period. Nearest wins.
  const find = (name: string): XmlNode | null => {
    const own = childNamed(representation, name)
    if (own) return own
    for (let index = parents.length - 1; index >= 0; index -= 1) {
      const node = parents[index]
      const found = node ? childNamed(node, name) : null
      if (found) return found
    }
    return null
  }

  const template = find('SegmentTemplate')
  if (template) {
    const attributes = template.attributes
    const timescale = num(attributes['timescale']) ?? 1
    const startNumber = num(attributes['startNumber']) ?? 1
    const initTemplate = attributes['initialization']
    const mediaTemplate = attributes['media'] ?? ''

    const init =
      initTemplate === undefined
        ? null
        : resolveUrl(fillTemplate(initTemplate, { representationId: id, bandwidth }), base)

    const timeline = childNamed(template, 'SegmentTimeline')
    if (timeline) {
      const times = expandTimeline(timeline, DASH_LIMITS.maxSegments)
      return {
        // A timeline lists every segment explicitly; nothing is estimated.
        certain: null,
        init,
        segments: times.map((time, index) =>
          resolveUrl(
            fillTemplate(mediaTemplate, {
              representationId: id,
              bandwidth,
              time,
              number: startNumber + index
            }),
            base
          )
        )
      }
    }

    // No timeline: fixed-duration segments, and the count comes from the
    // period's length. Without a length there is no way to know where to stop,
    // and inventing a number would download half a film.
    const duration = num(attributes['duration'])
    if (duration === null || duration <= 0 || periodSeconds <= 0) {
      return { init, segments: [], certain: null }
    }
    const perSegment = duration / timescale
    const count = Math.min(Math.ceil(periodSeconds / perSegment), DASH_LIMITS.maxSegments)
    // Plus a short look-ahead: packagers routinely write one or two more than
    // they declare, and stopping at the declared count truncates the video.
    const planned = Math.min(count + SEGMENT_LOOK_AHEAD, DASH_LIMITS.maxSegments)
    return {
      init,
      certain: count,
      segments: Array.from({ length: planned }, (_unused, index) =>
        resolveUrl(
          fillTemplate(mediaTemplate, {
            representationId: id,
            bandwidth,
            number: startNumber + index
          }),
          base
        )
      )
    }
  }

  const list = find('SegmentList')
  if (list) {
    const initSource = childNamed(list, 'Initialization')?.attributes['sourceURL']
    return {
      // An explicit list is exactly the segments there are.
      certain: null,
      init: initSource === undefined ? null : resolveUrl(initSource, base),
      segments: childrenNamed(list, 'SegmentURL')
        .slice(0, DASH_LIMITS.maxSegments)
        .map((entry) => entry.attributes['media'])
        .filter((media): media is string => media !== undefined && media !== '')
        .map((media) => resolveUrl(media, base))
    }
  }

  // `SegmentBase`, or nothing at all: the representation *is* one file, named by
  // its own BaseURL. Downloading it is downloading that file.
  const ownBase = childNamed(representation, 'BaseURL')?.text.trim()
  if (ownBase && ownBase !== '') {
    return { init: null, segments: [resolveUrl(ownBase, base)], certain: null }
  }
  return { init: null, segments: [], certain: null }
}

function kindOf(mimeType: string, codecs: string, contentType: string | undefined): DashTrackKind {
  const haystack = `${contentType ?? ''} ${mimeType}`.toLowerCase()
  if (haystack.includes('video')) return 'video'
  if (haystack.includes('audio')) return 'audio'
  if (haystack.includes('text') || haystack.includes('ttml') || haystack.includes('vtt')) return 'text'
  // Some packagers describe the track only by its codec.
  if (/^(avc|hev|hvc|vp0?9|av01)/i.test(codecs)) return 'video'
  if (/^(mp4a|opus|ec-3|ac-3|vorbis|flac)/i.test(codecs)) return 'audio'
  return 'other'
}

/**
 * Reads a manifest into the tracks it offers, or refuses with a reason.
 *
 * `manifestUrl` is needed for more than tidiness: every address in an MPD may
 * be relative, and to four different levels of the document.
 */
export function parseMpd(source: string, manifestUrl: string): DashResult {
  const parsed = parseXml(source)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }

  const mpd = parsed.root
  if (mpd.name !== 'MPD') return { ok: false, reason: 'This is not an MPEG-DASH manifest.' }

  if ((mpd.attributes['type'] ?? 'static').toLowerCase() === 'dynamic') {
    return {
      ok: false,
      reason:
        'Live MPEG-DASH streams are not currently supported. A live manifest has no end, so ' +
        'saving one means choosing a moment to stop — that is recording, not downloading.'
    }
  }

  const periods = childrenNamed(mpd, 'Period')
  if (periods.length === 0) return { ok: false, reason: 'This manifest lists nothing to play.' }
  if (periods.length > 1) {
    return {
      ok: false,
      reason:
        'Multi-period MPEG-DASH streams are not currently supported. This one is several ' +
        'presentations spliced together, and joining them correctly is more than Slash does.'
    }
  }

  const period = periods[0]
  if (!period) return { ok: false, reason: 'This manifest lists nothing to play.' }

  const mpdBase = baseFor(mpd, manifestUrl)
  const periodBase = baseFor(period, mpdBase)
  const durationSeconds =
    parseDuration(period.attributes['duration']) ||
    parseDuration(mpd.attributes['mediaPresentationDuration'])

  const video: DashRepresentation[] = []
  const audio: DashRepresentation[] = []
  let seen = 0
  let protectedTracks = 0

  for (const adaptation of childrenNamed(period, 'AdaptationSet')) {
    const adaptationBase = baseFor(adaptation, periodBase)
    // Encryption is recognised so it can be excluded and explained. Slash does
    // not unpick a service's protection, here or anywhere else.
    const encrypted = childrenNamed(adaptation, 'ContentProtection').length > 0

    for (const representation of childrenNamed(adaptation, 'Representation')) {
      seen += 1
      if (seen > DASH_LIMITS.maxRepresentations) break

      if (encrypted || childrenNamed(representation, 'ContentProtection').length > 0) {
        protectedTracks += 1
        continue
      }

      const attributes = { ...adaptation.attributes, ...representation.attributes }
      const id = attributes['id'] ?? ''
      const bandwidth = num(attributes['bandwidth']) ?? 0
      const mimeType = attributes['mimeType'] ?? ''
      const codecs = attributes['codecs'] ?? ''
      const base = baseFor(representation, adaptationBase)

      const { init, segments, certain } = segmentsFor(
        representation,
        [adaptation, period],
        base,
        id,
        bandwidth,
        durationSeconds
      )
      if (segments.length === 0) continue

      const track: DashRepresentation = {
        id,
        kind: kindOf(mimeType, codecs, attributes['contentType']),
        mimeType,
        codecs,
        bandwidth,
        width: num(attributes['width']),
        height: num(attributes['height']),
        lang: attributes['lang'] ?? null,
        initSegment: init,
        segments,
        certainSegments: certain
      }

      if (track.kind === 'video') video.push(track)
      else if (track.kind === 'audio') audio.push(track)
    }
  }

  if (video.length === 0 && audio.length === 0) {
    return {
      ok: false,
      reason:
        protectedTracks > 0
          ? 'Every track in this stream is encrypted by the site. Slash does not work around a ' +
            'service’s technical protections, so there is nothing here it can download.'
          : 'This manifest lists no tracks Slash can assemble into a playable file.'
    }
  }

  const byBandwidth = (a: DashRepresentation, b: DashRepresentation): number => b.bandwidth - a.bandwidth
  return {
    ok: true,
    manifest: { durationSeconds, video: [...video].sort(byBandwidth), audio: [...audio].sort(byBandwidth) }
  }
}

/**
 * The video and audio to actually download.
 *
 * Best video by declared bitrate unless the user picked one, and the best audio
 * alongside it. Audio is chosen independently because that is how DASH works —
 * the two are separate streams so the player can drop the picture quality
 * without interrupting the sound — and they are joined afterwards by the muxer.
 */
export function selectTracks(
  manifest: DashManifest,
  chosenVideoId?: string
): { video: DashRepresentation | null; audio: DashRepresentation | null } {
  const video =
    (chosenVideoId === undefined
      ? manifest.video[0]
      : manifest.video.find((track) => track.id === chosenVideoId)) ?? manifest.video[0] ?? null
  return { video, audio: manifest.audio[0] ?? null }
}

/** `1920x1080` → `1080p`, for the picker. */
export function qualityLabelFor(track: DashRepresentation): string {
  if (track.height !== null && track.height > 0) return `${track.height}p`
  if (track.bandwidth > 0) return `${Math.round(track.bandwidth / 1000)} kbps`
  return track.id === '' ? 'Stream' : track.id
}
