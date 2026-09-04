/**
 * Reading the download options a video page already knows about.
 *
 * ## Why the network sniffer alone was not enough
 *
 * `MediaSniffer` watches responses and offers complete files. On a site that
 * serves one `.mp4`, that is the whole answer. On YouTube it finds nothing
 * usable, and the reason is worth writing down because it is not obvious:
 * YouTube's media arrives from `videoplayback` URLs fetched in small byte
 * ranges, increasingly wrapped in its own transport format, so what a response
 * observer sees is a few hundred kilobytes of something that is not a file. The
 * chip never appeared because there was genuinely nothing a response observer
 * could honestly offer.
 *
 * The page, however, has the answer sitting in a variable. YouTube puts every
 * available format — URL, resolution, byte length — into `ytInitialPlayerResponse`
 * before the player starts. Reading it is how every download tool works, and it
 * is a read: nothing is decrypted, no protection is worked around, and a video
 * that is actually protected is refused here exactly as it is everywhere else.
 *
 * Pure, because the shape is somebody else's and changes without warning. Every
 * field is optional, every parse failure means "no options" rather than a throw,
 * and the tests pin the shapes that have actually been seen.
 */

/** One thing the user can choose to download. */
export interface MediaChoice {
  readonly url: string
  /** "1080p", "360p · with audio", "Audio only". */
  readonly label: string
  /** Bytes, when the page said. */
  readonly size: number | null
  readonly mimeType: string
  readonly hasVideo: boolean
  readonly hasAudio: boolean
  /**
   * Whether this one file plays on its own.
   *
   * The distinction the whole feature turns on. A "progressive" format carries
   * picture and sound together and is a finished video. An adaptive format is
   * one half of a pair, and downloading it alone gets you a silent film or a
   * black screen with music — which is the kind of thing that makes somebody
   * conclude a browser is broken.
   */
  readonly complete: boolean
}

/** Raw shape from the page. Everything optional: it is not our object. */
export interface RawFormat {
  url?: unknown
  mimeType?: unknown
  qualityLabel?: unknown
  audioQuality?: unknown
  contentLength?: unknown
  height?: unknown
  width?: unknown
  bitrate?: unknown
  /** Present instead of `url` when the address needs the page's own JS to build. */
  signatureCipher?: unknown
  cipher?: unknown
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(str(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** `video/mp4; codecs="avc1.64, mp4a.40.2"` → what is actually in it. */
export function tracksIn(mimeType: string): { video: boolean; audio: boolean } {
  const lower = mimeType.toLowerCase()
  const codecs = /codecs="([^"]*)"/.exec(lower)?.[1] ?? ''
  const parts = codecs
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')

  if (parts.length > 0) {
    // A codec string is the reliable signal: two codecs means both tracks.
    const audio = parts.some((codec) => /^(mp4a|opus|vorbis|ec-3|ac-3|flac)/.test(codec))
    const video = parts.some((codec) => /^(avc1|av01|vp0?9|vp8|hev1|hvc1)/.test(codec))
    return { video, audio }
  }

  return { video: lower.startsWith('video/'), audio: lower.startsWith('audio/') }
}

function toChoice(format: RawFormat, progressive: boolean): MediaChoice | null {
  const url = str(format.url)
  // A format whose address has to be built by running the page's own signature
  // code is deliberately skipped rather than half-attempted. Offering a button
  // that produces a 403 is worse than offering one fewer option.
  if (url === '' || !/^https?:\/\//i.test(url)) return null

  const mimeType = str(format.mimeType)
  const tracks = tracksIn(mimeType)
  const quality = str(format.qualityLabel)
  const height = num(format.height)

  const resolution = quality !== '' ? quality : height !== null ? `${height}p` : ''
  const label = tracks.video
    ? `${resolution === '' ? 'Video' : resolution}${tracks.audio ? '' : ' · no sound'}`
    : 'Audio only'

  return {
    url,
    label,
    size: num(format.contentLength),
    mimeType: mimeType.split(';')[0]?.trim() ?? '',
    hasVideo: tracks.video,
    hasAudio: tracks.audio,
    // Progressive formats are complete by definition; an adaptive one is only
    // complete if it happens to carry both tracks, which some do.
    complete: progressive || (tracks.video && tracks.audio)
  }
}

export interface RawStreamingData {
  formats?: unknown
  adaptiveFormats?: unknown
}

/**
 * Every option worth showing, best first.
 *
 * Ordering is the whole user experience here. Complete files rank above halves,
 * because one click producing a playable video is the point. Within those,
 * bigger is better — resolution and byte length agree closely enough, and byte
 * length is the one both progressive and adaptive formats always report.
 */
export function choicesFrom(data: RawStreamingData | null | undefined): MediaChoice[] {
  return analyseFormats(data).choices
}

/**
 * The same, plus what was left out and why.
 *
 * The distinction matters because the two empty outcomes need different
 * sentences. "This page lists no media" is a page we cannot read. "Every format
 * on this page has a signed address" is a page we *can* read, whose addresses
 * have to be assembled by running the site's own signature code — which this
 * browser does not do. Telling somebody the first when it is the second sends
 * them off to check whether the feature is broken.
 */
export function analyseFormats(data: RawStreamingData | null | undefined): {
  choices: MediaChoice[]
  /** Formats skipped because their address is signed rather than given. */
  signed: number
  /**
   * Formats with no address at all — not a signed one, none.
   *
   * A separate count because it is a separate fact, and the difference decides
   * what the user is told. A signed address exists and is withheld behind the
   * site's own code. These have neither: the page lists the *format* and the
   * player then negotiates the bytes with the server as it goes, so there is no
   * URL anywhere on the page for anything to fetch. Measured on a real watch
   * page, where all thirty formats were this shape and the old count reported
   * zero of everything — which read as "this page has no video on it".
   */
  serverDriven: number
} {
  if (!data || typeof data !== 'object') return { choices: [], signed: 0, serverDriven: 0 }

  const progressive = Array.isArray(data.formats) ? (data.formats as RawFormat[]) : []
  const adaptive = Array.isArray(data.adaptiveFormats) ? (data.adaptiveFormats as RawFormat[]) : []

  const all = [...progressive, ...adaptive]
  const choices = all
    .map((format, index) => toChoice(format, index < progressive.length))
    .filter((choice): choice is MediaChoice => choice !== null)

  const withoutUrl = all.filter((format) => str(format.url) === '')
  const signed = withoutUrl.filter(
    (format) => format.signatureCipher !== undefined || format.cipher !== undefined
  ).length

  const byUrl = new Map<string, MediaChoice>()
  for (const choice of choices) if (!byUrl.has(choice.url)) byUrl.set(choice.url, choice)

  return {
    signed,
    serverDriven: withoutUrl.length - signed,
    choices: [...byUrl.values()].sort((a, b) => {
      if (a.complete !== b.complete) return a.complete ? -1 : 1
      if (a.hasVideo !== b.hasVideo) return a.hasVideo ? -1 : 1
      return (b.size ?? 0) - (a.size ?? 0)
    })
  }
}

/**
 * Said when every option on offer is one half of a pair.
 *
 * Exported because whether it is true depends on something this module cannot
 * see: with a muxer present a picture-only stream downloads as one finished
 * file, and the sentence then describes a limitation that no longer applies.
 * The caller that knows drops it by identity rather than by matching a
 * substring of prose that will be reworded one day.
 */
export const SEPARATE_STREAMS_NOTE =
  'Only separate video and audio streams are available here. Slash does not combine them ' +
  'into one file, so each downloads on its own.'

/**
 * What to say about the formats a page listed and this cannot offer.
 *
 * Null when there is nothing to explain.
 *
 * The signed count is reported **whether or not anything else was offerable**,
 * and that is the fix for the complaint that started this: a page listing one
 * 360p file and twenty signed higher resolutions used to show a single row and
 * no explanation, which reads as "360p is all this video has". It is not — it
 * is all this browser can reach without running the site's own signature code,
 * and saying so is the difference between a known limit and a broken feature.
 */
export function formatsNote(analysis: {
  choices: MediaChoice[]
  signed: number
  serverDriven?: number
}): string | null {
  const parts: string[] = []
  const serverDriven = analysis.serverDriven ?? 0
  const offerable = analysis.choices.length > 0
  const plural = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`

  if (offerable && !analysis.choices.some((choice) => choice.complete)) {
    parts.push(SEPARATE_STREAMS_NOTE)
  }

  if (analysis.signed > 0) {
    parts.push(
      offerable
        ? `${plural(analysis.signed, 'other format', 'other formats')} on this page — usually the ` +
            `higher resolutions — ${analysis.signed === 1 ? 'has a signed address' : 'have signed addresses'}, ` +
            'which has to be built by running the site’s own code. Slash does not do that, so it ' +
            `${analysis.signed === 1 ? 'is' : 'they are'} not listed here.`
        : `${plural(analysis.signed, 'format on this page has', 'formats on this page have')} a ` +
            'signed address, which has to be built by running the site’s own code. Slash does not ' +
            'do that.'
    )
  }

  if (serverDriven > 0) {
    // The honest version of what used to be an empty list. This is not a
    // limitation of the extractor: the page genuinely does not contain an
    // address for these, because the player asks the server for each piece as
    // it plays. Saying "nothing found" invited somebody to go and check whether
    // the feature was broken.
    //
    // Worded so it reads as one sentence beside the signed note above rather
    // than colliding with it — the two are very often both true, and the first
    // version of this produced "This video's 1 formats all have signed
    // addresses… This page lists 26 formats, but no address at all", which
    // contradicts itself twice in three lines.
    parts.push(
      `${plural(serverDriven, 'format carries', 'formats carry')} no address at all: the player ` +
        'negotiates each piece with the server as it plays, so there is no file here for any ' +
        'browser to fetch. Nothing is being withheld from Slash — the address does not exist ' +
        'until the player asks for it.'
    )
  }

  // Said once, at the end, rather than implied by each part separately.
  if (!offerable && parts.length > 0) {
    parts.push('There is nothing on this page Slash can download.')
  }

  return parts.length === 0 ? null : parts.join(' ')
}

/**
 * Whether a page is one this can read formats out of.
 *
 * Hostname-gated on purpose. Running an extraction script in a page's own world
 * is a capability to keep narrow — see the `ScriptletInjector` note in
 * CLAUDE.md — so it happens on the sites where it is known to work and nowhere
 * else, and only when the user asks for the list.
 */
export function isExtractablePage(url: string): boolean {
  let host: string
  let path: string
  try {
    const parsed = new URL(url)
    host = parsed.hostname.toLowerCase()
    path = parsed.pathname
  } catch {
    return false
  }

  const youtube =
    host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be'
  if (!youtube) return false

  // A watch page or a short. The home page has no single video to offer, and a
  // chip floating over a grid of thumbnails would be pointing at nothing.
  return path === '/watch' || path.startsWith('/shorts/') || host === 'youtu.be'
}

/**
 * A short human name for what is playing, for the filename.
 *
 * Falls back rather than returning empty: a download called `videoplayback` is
 * one nobody finds again, and that is exactly what YouTube's URLs are called.
 */
export function safeTitle(title: string, fallback = 'video'): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned === '' ? fallback : cleaned
}

/** `video/mp4` → `mp4`. */
export function extensionFor(mimeType: string, hasVideo: boolean): string {
  const subtype = mimeType.toLowerCase().split('/')[1] ?? ''
  if (subtype.includes('mp4')) return hasVideo ? 'mp4' : 'm4a'
  if (subtype.includes('webm')) return hasVideo ? 'webm' : 'weba'
  return hasVideo ? 'mp4' : 'm4a'
}

/**
 * Why there is nothing to offer, when there is nothing.
 *
 * Re-exported through this module so the picker has one place to ask. It
 * forwards to `sniffNote`, which names the actual limit — segmented delivery, or
 * encryption — rather than leaving an empty list that reads as a broken feature.
 */
export { sniffNote as sniffNoteFor } from './mediaSniffing'
