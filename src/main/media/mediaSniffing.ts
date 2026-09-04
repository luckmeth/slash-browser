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

import { mediaIdentity } from './mediaIdentity'

export type SniffedKind =
  /** A complete file. Downloadable as-is. */
  | 'file'
  /** HLS or DASH: a manifest listing segments. Needs assembling. */
  | 'stream'
  /** Encrypted. Recognised so it can be refused with a reason. */
  | 'protected'
  /**
   * The player's own transport framing, not a file.
   *
   * Recognised so the picker can say why there is nothing here, rather
   * than offering a download that produces an unplayable file.
   */
  | 'transport'

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
  /**
   * The page that actually requested this, which is often **not** the tab's URL.
   *
   * Film sites put the player in a cross-origin iframe: the tab is on
   * `123moviesfree.net` while the request comes from `if9.ppzj-youtube.cfd`.
   * The CDN checks its referrer against the *player's* origin, so downloading
   * with the top-level page as referrer is a different claim from the one the
   * player made — and these hosts answer that with 403.
   *
   * Optional, and absent when the frame could not be identified — in which case
   * the caller falls back to the tab's URL, which is what it always used.
   */
  readonly frameUrl?: string
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

/**
 * Hosts whose media addresses carry an expiry and stop working once it passes.
 *
 * Not a block list. An earlier version of this file *excluded* googlevideo
 * entirely, on the theory that its addresses were locked to the player session
 * — and that was wrong. Measured with `SLASH_MEDIA_ACCESS_PROBE` against a live
 * watch page, a sniffed `videoplayback` URL answers **206** to the engine's own
 * requests: bare, with the session, with the page context, and with both
 * `Range: bytes=0-0` and a real range. It downloads.
 *
 * What it does not survive is time. These addresses carry `expire=`, and the
 * 403s that prompted the mistaken theory were downloads queued against
 * addresses captured before the user navigated on to other videos. So the host
 * is recognised in order to explain *that* failure accurately, not to refuse
 * the download.
 */
/**
 * Content types that are a player's private framing rather than a media file.
 *
 * `vnd.yt-ump` is YouTube's; the others are the same idea elsewhere. Matched on
 * the content type rather than the host, because the host serves both this and
 * ordinary `video/mp4` depending on which delivery path the session got - and
 * the two need opposite answers.
 */
const TRANSPORT_TYPES = ['vnd.yt-ump', 'ump', 'application/vnd.yt-sabr']

const EXPIRING_MEDIA_HOSTS = ['googlevideo.com', '/videoplayback']

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
  size: number | null,
  frameUrl = ''
): SniffedMedia | null {
  if (!/^https?:/i.test(url)) return null

  const path = pathOf(url)
  const type = lower(contentType).split(';')[0]?.trim() ?? ''
  const haystack = lower(url)

  if (PROTECTION_HINTS.some((hint) => haystack.includes(hint))) {
    return {
      url,
      kind: 'protected',
      media: null,
      label: 'Protected stream',
      size,
      contentType: type,
      frameUrl
    }
  }

  // A player's own transport framing, recognised in order to be excluded and
  // **explained** - the same reason DRM traffic and bare manifests are.
  //
  // Measured on a live watch page: YouTube serves media as
  // `application/vnd.yt-ump` over XHR with no content length. That is not a
  // video file. It is a stream of protobuf-framed chunks that only its own
  // player can de-frame, so saving one produces a file nothing will play, and
  // no amount of work on the *download* side changes that. Offering it would
  // be the worst kind of failure: a button that completes and hands somebody
  // something broken.
  if (TRANSPORT_TYPES.some((hint) => type.includes(hint))) {
    return {
      url,
      kind: 'transport',
      media: null,
      label: 'Player transport stream',
      size,
      contentType: type,
      frameUrl
    }
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
      contentType: type,
      frameUrl
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
    contentType: type,
    frameUrl
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
  // Keyed by identity rather than by address. A player re-requests its manifest
  // with a fresh token every few minutes, and keying by URL grew a second row
  // for the same film under a different signature — then a third.
  const byUrl = new Map<string, SniffedMedia>()
  for (const candidate of candidates) {
    const identity = mediaIdentity(candidate.url)
    const existing = byUrl.get(identity)
    // Keep whichever knows its size — the same URL is often seen twice, once
    // from a range request that reported nothing. The **address** is always the
    // newer one: the older token may already have expired.
    if (!existing) {
      byUrl.set(identity, candidate)
    } else if (existing.size === null && candidate.size !== null) {
      byUrl.set(identity, candidate)
    } else {
      byUrl.set(identity, { ...existing, url: candidate.url })
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
 * Complete files and streams. A stream is offered without a size, because a
 * playlist has no length of its own — the segments carry it, and they are not
 * listed until the playlist is read. `StreamDownload` joins them on download.
 *
 * A **protected** stream is still not offered and never will be. That is the
 * line: a button producing an unplayable file is worse than a sentence saying
 * why there is no button, and `sniffNote` supplies the sentence.
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
    .filter((item) => item.kind === 'file' || item.kind === 'stream')
    .map((item) =>
      item.kind === 'stream'
        ? {
            url: item.url,
            kind: 'video' as const,
            container: 'stream',
            resolution: null,
            // A playlist has no length of its own — the size comes from the
            // segments, which are not listed until it is read. Stated as
            // unknown rather than guessed at from the manifest's few kilobytes.
            sizeBytes: null,
            label: `${item.label} · joined on download`
          }
        : {
            url: item.url,
            kind: item.media ?? 'video',
            container: containerOf(item.url, item.contentType),
            resolution: null,
            sizeBytes: item.size,
            label: `${suggestedFilename(item.url, 'file')} · ${formatSize(item.size)}`
          }
    )
}

/**
 * What to say when the network saw media but none of it can be downloaded.
 *
 * Returns null when there is nothing to explain. Naming the actual reason — a
 * manifest, or encryption — is the difference between a feature that looks
 * broken and one whose limits are understood.
 */
export function sniffNote(found: readonly SniffedMedia[]): string | null {
  if (found.some((item) => item.kind === 'file' || item.kind === 'stream')) return null
  if (found.some((item) => item.kind === 'protected')) {
    return (
      'This video is encrypted by the site. Slash does not work around a service’s technical ' +
      'protections, so it cannot be downloaded here.'
    )
  }
  if (found.some((item) => item.kind === 'transport')) {
    return (
      'This site is streaming in its own transport format rather than as video files — the player ' +
      'asks the server for each piece as it plays and unwraps it in the page. There is no file ' +
      'here for any browser to save, and one assembled from these pieces would not play. Nothing ' +
      'is being withheld from Slash; on this connection the video does not exist as a file at all.'
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

  /**
   * Records one response.
   *
   * Returns whether this changed anything, so the caller can skip recomputing
   * and broadcasting. A playing video re-requests the same URL constantly —
   * byte-range requests are how seeking and buffering work — and every one of
   * those arrives here. Treating each as news would mean a full re-rank and an
   * IPC broadcast several times a second for a button that is already showing.
   */
  record(tabId: number, item: SniffedMedia): boolean {
    const generation = this.generations.get(tabId) ?? 0
    const existing = this.entries.get(tabId) ?? []

    const identity = mediaIdentity(item.url)
    const already = existing.find(
      (entry) => entry.generation === generation && mediaIdentity(entry.item.url) === identity
    )
    if (already) {
      // A range request reports no length; a later one may. Keep whichever
      // knows, but this is still not a change worth telling anybody about.
      //
      // The address is refreshed either way: the entry may have been recorded
      // with a token that has since expired, and downloading from a stale one
      // is a 403 on a row that looked fine.
      if (already.item.size === null && item.size !== null) already.item = item
      else already.item = { ...already.item, url: item.url }
      return false
    }

    this.entries.set(tabId, [{ generation, item }, ...existing].slice(0, MediaLedger.MAX_PER_TAB))
    return true
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

/**
 * When a media address stops working, when it says so.
 *
 * Streaming CDNs sign a URL with a deadline — `expire=` on googlevideo, and the
 * same idea under other names elsewhere. Once it passes, the server answers 403
 * to everyone including the browser that was just playing it, and "Server
 * returned 403" is a true but useless thing to tell somebody: it reads as a
 * refusal aimed at them, when the address has simply gone stale.
 *
 * Pure, and returns null when there is nothing to read rather than guessing a
 * lifetime. Seconds since the epoch, converted to milliseconds.
 */
export function mediaUrlExpiry(url: string): number | null {
  let params: URLSearchParams
  try {
    params = new URL(url).searchParams
  } catch {
    return null
  }
  for (const key of ['expire', 'expires', 'e', 'valid_until']) {
    const raw = params.get(key)
    if (raw === null) continue
    const seconds = Number(raw)
    // Ten digits is a Unix timestamp in seconds; anything shorter is a
    // duration or an id and means nothing as a deadline.
    if (!Number.isFinite(seconds) || seconds < 1_000_000_000) continue
    return seconds * 1000
  }
  return null
}

/** Whether this address is one that goes stale, and has. */
export function mediaUrlHasExpired(url: string, now = Date.now()): boolean {
  const expiry = mediaUrlExpiry(url)
  return expiry !== null && expiry <= now
}

/** Whether the host is one whose addresses carry a deadline at all. */
export function isExpiringMediaHost(url: string): boolean {
  const haystack = url.toLowerCase()
  return EXPIRING_MEDIA_HOSTS.some((hint) => haystack.includes(hint))
}
