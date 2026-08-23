/**
 * Recognising media a page is streaming, from the requests it makes.
 *
 * Pure, because the classification is all judgement and the failure modes are
 * quiet: offer a 2-second advert as "the video", miss the real one entirely, or
 * list forty identical segments instead of the stream they belong to. None of
 * those throw; they just make the feature useless in a way that only shows up
 * on real sites.
 *
 * **This does not circumvent DRM and must not be made to.** Encrypted streams
 * (Widevine, PlayReady, FairPlay) are recognised so they can be *excluded* and
 * labelled honestly, not so they can be decrypted. Netflix and Disney+ will not
 * work here, exactly as they do not work in any download manager, and telling
 * the user that plainly is better than a download that produces an unplayable
 * file.
 */

export type SniffedKind =
  /** A complete file. Downloadable as-is. */
  | 'file'
  /** HLS or DASH: a manifest listing segments. Needs assembling. */
  | 'stream'
  /** Encrypted. Recognised so it can be refused with a reason. */
  | 'protected'

export interface SniffedMedia {
  readonly url: string
  readonly kind: SniffedKind
  /** Video or audio, where that is knowable. Null for a manifest or a licence. */
  readonly media: 'video' | 'audio' | null
  /** What to call it in the list. */
  readonly label: string
  /** Bytes, when the response said. */
  readonly size: number | null
  readonly contentType: string
}

const FILE_EXTENSIONS = ['.mp4', '.webm', '.m4v', '.mov', '.mkv', '.avi', '.flv', '.ogv']
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.flac']
const MANIFEST_EXTENSIONS = ['.m3u8', '.mpd']

/**
 * Segments of a stream, which must never be listed individually.
 *
 * A two-hour film is thousands of these. Listing them turns a useful panel into
 * an unusable one, and downloading a single segment gives somebody four seconds
 * of video they cannot play.
 */
const SEGMENT_EXTENSIONS = ['.ts', '.m4s', '.cmfv', '.cmfa']

/** Signals the response is encrypted and cannot be assembled into a playable file. */
const PROTECTION_HINTS = [
  'widevine',
  'playready',
  'fairplay',
  'clearkey',
  '/license',
  'licenseserver',
  'drmtoday'
]

const lower = (value: string): string => value.toLowerCase()

/** The path part, without query or fragment — extensions hide behind both. */
export function pathOf(url: string): string {
  try {
    return lower(new URL(url).pathname)
  } catch {
    return lower(url.split('?')[0]?.split('#')[0] ?? '')
  }
}

const endsWithAny = (path: string, endings: readonly string[]): boolean =>
  endings.some((ending) => path.endsWith(ending))

/**
 * What this response is, or null if it is not media worth offering.
 *
 * @param size `Content-Length`, when the server sent one.
 */
export function classifyMedia(
  url: string,
  contentType: string,
  size: number | null
): SniffedMedia | null {
  if (!/^https?:/i.test(url)) return null

  const path = pathOf(url)
  const type = lower(contentType).split(';')[0]?.trim() ?? ''
  const haystack = lower(url)

  if (PROTECTION_HINTS.some((hint) => haystack.includes(hint))) {
    return { url, kind: 'protected', media: null, label: 'Protected stream', size, contentType: type }
  }

  // Segments first: they are media by content type and must still be dropped.
  if (endsWithAny(path, SEGMENT_EXTENSIONS)) return null

  if (endsWithAny(path, MANIFEST_EXTENSIONS) || type.includes('mpegurl') || type.includes('dash+xml')) {
    return {
      url,
      kind: 'stream',
      media: null,
      label: path.endsWith('.mpd') || type.includes('dash') ? 'DASH stream' : 'HLS stream',
      size,
      contentType: type
    }
  }

  const isVideo = type.startsWith('video/') || endsWithAny(path, FILE_EXTENSIONS)
  const isAudio = type.startsWith('audio/') || endsWithAny(path, AUDIO_EXTENSIONS)
  if (!isVideo && !isAudio) return null

  // Tiny responses are almost always a poster, a beacon, or a probe. Offering
  // them buries the one file somebody actually wants.
  if (size !== null && size < 100_000) return null

  return {
    url,
    kind: 'file',
    media: isAudio ? 'audio' : 'video',
    label: isAudio ? 'Audio file' : 'Video file',
    size,
    contentType: type
  }
}

/**
 * The list to show, best first.
 *
 * Ordering matters more than it looks: whatever is at the top is what somebody
 * clicks. A complete file beats a manifest, because it downloads to something
 * playable without assembly; a bigger file beats a smaller one, because the
 * small one is usually the advert that played before the feature.
 */
export function rankCandidates(candidates: readonly SniffedMedia[]): SniffedMedia[] {
  const byUrl = new Map<string, SniffedMedia>()
  for (const candidate of candidates) {
    const existing = byUrl.get(candidate.url)
    // Keep whichever knows its size — the same URL is often seen twice, once
    // from a range request that reported nothing.
    if (!existing || (existing.size === null && candidate.size !== null)) {
      byUrl.set(candidate.url, candidate)
    }
  }

  const rank = (kind: SniffedKind): number => (kind === 'file' ? 0 : kind === 'stream' ? 1 : 2)

  return [...byUrl.values()].sort((a, b) => {
    if (rank(a.kind) !== rank(b.kind)) return rank(a.kind) - rank(b.kind)
    return (b.size ?? 0) - (a.size ?? 0)
  })
}

/** `1234567` → `1.2 MB`. Null when the server never said. */
export function formatSize(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return 'unknown size'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * A filename for a saved media URL.
 *
 * Derived from the path, because a stream's URL is usually the only name it
 * has. Falls back to something dated rather than empty — a download with no
 * name is one nobody finds again.
 */
export function suggestedFilename(url: string, kind: SniffedKind): string {
  const path = pathOf(url)
  const last = path.split('/').filter((part) => part !== '').pop() ?? ''
  const cleaned = last.replace(/[^a-z0-9._-]/gi, '')

  if (kind === 'stream' || cleaned === '' || !cleaned.includes('.')) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    return `video-${stamp}.mp4`
  }
  return cleaned
}

/** The container, for the row in the panel. `null` when nothing says. */
export function containerOf(url: string, contentType: string): string | null {
  const ext = pathOf(url).split('.').pop() ?? ''
  if (ext !== '' && ext.length <= 5 && /^[a-z0-9]+$/.test(ext) && pathOf(url).includes('.')) {
    return ext
  }
  const subtype = lower(contentType).split(';')[0]?.split('/')[1] ?? ''
  return subtype === '' ? null : subtype
}

/**
 * The shape the existing media panel already renders.
 *
 * Only complete files. A manifest is not offered because assembling one is work
 * this browser does not do, and a protected stream is not offered because it
 * cannot be — both are explained in `sniffNote` instead. A button that produces
 * an unplayable file is worse than a sentence saying why there is no button.
 */
export interface DownloadableMedia {
  url: string
  kind: 'video' | 'audio'
  container: string | null
  resolution: string | null
  sizeBytes: number | null
  label: string
}

export function toDownloadable(found: readonly SniffedMedia[]): DownloadableMedia[] {
  return rankCandidates(found)
    .filter((item) => item.kind === 'file')
    .map((item) => ({
      url: item.url,
      kind: item.media ?? 'video',
      container: containerOf(item.url, item.contentType),
      resolution: null,
      sizeBytes: item.size,
      label: `${suggestedFilename(item.url, 'file')} · ${formatSize(item.size)}`
    }))
}

/**
 * What to say when the network saw media but none of it can be downloaded.
 *
 * Returns null when there is nothing to explain. Naming the actual reason — a
 * manifest, or encryption — is the difference between a feature that looks
 * broken and one whose limits are understood.
 */
export function sniffNote(found: readonly SniffedMedia[]): string | null {
  if (found.some((item) => item.kind === 'file')) return null
  if (found.some((item) => item.kind === 'protected')) {
    return (
      'This video is encrypted by the site. Slash does not work around a service’s technical ' +
      'protections, so it cannot be downloaded here.'
    )
  }
  if (found.some((item) => item.kind === 'stream')) {
    return (
      'This video is delivered as an adaptive stream — thousands of short segments rather than ' +
      'one file. Slash does not reassemble those, so there is nothing here to download.'
    )
  }
  return null
}

/**
 * What each tab has been seen fetching, and which document it belonged to.
 *
 * Kept separate from the Electron plumbing so the awkward part is testable. The
 * awkward part is single-page navigation: clicking the next video on YouTube
 * does not load a new document, so nothing resets — but the new video's first
 * requests can arrive either side of the route change. Clearing on the route
 * change alone would sometimes throw away the very thing the user then asks for.
 *
 * So entries are tagged with a generation, and a lookup answers from the newest
 * generation that actually has something. The previous video stays available
 * only until the new one has been seen, which is the behaviour somebody would
 * describe as "it just works".
 */
export class MediaLedger {
  /** Per tab. A long viewing session must not grow without bound. */
  static readonly MAX_PER_TAB = 60

  private readonly entries = new Map<number, { generation: number; item: SniffedMedia }[]>()
  private readonly generations = new Map<number, number>()

  record(tabId: number, item: SniffedMedia): void {
    const generation = this.generations.get(tabId) ?? 0
    const existing = this.entries.get(tabId) ?? []
    this.entries.set(tabId, [{ generation, item }, ...existing].slice(0, MediaLedger.MAX_PER_TAB))
  }

  /** A navigation happened — same document or not. */
  advance(tabId: number): void {
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1)
  }

  /** The tab's media, best first, from the newest generation that has any. */
  forTab(tabId: number): SniffedMedia[] {
    const all = this.entries.get(tabId) ?? []
    if (all.length === 0) return []

    const newest = Math.max(...all.map((entry) => entry.generation))
    for (let generation = newest; generation >= 0; generation -= 1) {
      const matching = all.filter((entry) => entry.generation === generation)
      if (matching.length > 0) return rankCandidates(matching.map((entry) => entry.item))
    }
    return []
  }

  forget(tabId: number): void {
    this.entries.delete(tabId)
    this.generations.delete(tabId)
  }
}
