/**
 * Reading yt-dlp's two outputs: its format dump, and its progress lines.
 *
 * Pure, and kept apart from the process plumbing, because both are text formats
 * belonging to a program that is upgraded independently of this one. A parser
 * that only runs when a real binary is present is a parser nothing tests, and
 * this one has to survive yt-dlp changing under it.
 */

export interface ExternalChoice {
  /** A yt-dlp format selector, not a URL. Handed straight back to the tool. */
  readonly selector: string
  readonly label: string
  /** The container the finished file will be in. */
  readonly ext: string
  readonly height: number | null
  readonly sizeBytes: number | null
  readonly sizeText: string
}

interface RawFormat {
  format_id?: unknown
  ext?: unknown
  vcodec?: unknown
  acodec?: unknown
  height?: unknown
  filesize?: unknown
  filesize_approx?: unknown
  format_note?: unknown
  tbr?: unknown
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Human bytes. Deliberately coarse — nobody needs three decimals of a gigabyte. */
export function sizeText(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return 'size unknown'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function qualityLabel(height: number): string {
  if (height >= 2160) return '2160p 4K'
  if (height >= 1440) return '1440p HD'
  if (height >= 1080) return '1080p HD'
  if (height >= 720) return '720p HD'
  return `${height}p`
}

/**
 * The distinct qualities a video is available in, best first.
 *
 * Grouped by **height** rather than listed per format, because yt-dlp reports a
 * dozen entries for one resolution — three codecs times several containers —
 * and a picker showing "1080p" nine times is not a choice, it is a puzzle.
 *
 * Each row becomes a *selector* rather than a URL: `bv*[height=1080]+ba/b`.
 * That is what makes this robust. yt-dlp resolves it at download time against
 * whatever the site is serving right then, so a stale address cannot happen and
 * the video/audio pairing is its problem rather than ours.
 *
 * The container follows what the codecs allow, the way IDM's own list does:
 * MP4 where H.264 and AAC exist at that height, MKV above it — 1440p and 2160p
 * are VP9 or AV1 on YouTube and cannot go in an MP4 alongside every player's
 * expectations.
 */
export function parseFormats(dump: unknown): { title: string; choices: ExternalChoice[] } {
  if (!dump || typeof dump !== 'object') return { title: '', choices: [] }
  const root = dump as { title?: unknown; formats?: unknown }
  const title = str(root.title)
  const formats = Array.isArray(root.formats) ? (root.formats as RawFormat[]) : []

  const byHeight = new Map<number, { size: number | null; mp4: boolean; note: string }>()

  for (const format of formats) {
    // Every entry is checked, not just the array. This parses output from a
    // program upgraded independently of this one, and a null in the list threw
    // before a test went looking for it.
    if (!format || typeof format !== 'object') continue
    const height = num(format.height)
    if (height === null || height <= 0) continue
    // Video tracks only. An audio-only entry has no height anyway, but a
    // thumbnail stream can carry one.
    if (str(format.vcodec) === 'none') continue

    const size = num(format.filesize) ?? num(format.filesize_approx)
    const codec = str(format.vcodec).toLowerCase()
    // H.264 is the one that goes in an MP4 every player opens.
    const mp4Capable = codec.startsWith('avc') || codec.startsWith('h264')

    // The site's own tier label when it gave one. A video that is not 16:9
    // reports true pixel heights - 546, 364, 182 - which are accurate and read
    // as broken next to "480p". YouTube already calls those 480p and 360p, and
    // its name for its own tier beats anything derived here.
    const note = /^\d{3,4}p\d*$/.test(str(format.format_note)) ? str(format.format_note) : ''

    const seen = byHeight.get(height)
    if (!seen) {
      byHeight.set(height, { size, mp4: mp4Capable, note })
      continue
    }
    // Keep the largest known size for the tier, and remember if *any* codec at
    // this height can be an MP4.
    byHeight.set(height, {
      size: seen.size === null ? size : size === null ? seen.size : Math.max(seen.size, size),
      mp4: seen.mp4 || mp4Capable,
      note: seen.note || note
    })
  }

  const choices: ExternalChoice[] = [...byHeight.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([height, info]) => {
      const ext = info.mp4 ? 'mp4' : 'mkv'
      return {
        // Falls back to a merged best-at-or-below, so a height that exists in
        // the listing but cannot be paired still produces a file.
        selector: `bv*[height=${height}]+ba/b[height<=${height}]`,
        label: `${ext.toUpperCase()} file, quality ${info.note || qualityLabel(height)}`,
        ext,
        height,
        sizeBytes: info.size,
        sizeText: sizeText(info.size)
      }
    })

  // Audio on its own is worth offering and is not a height.
  const hasAudio = formats.some(
    (format) =>
      !!format &&
      typeof format === 'object' &&
      str(format.acodec) !== 'none' &&
      str(format.acodec) !== ''
  )
  if (hasAudio) {
    choices.push({
      selector: 'ba/b',
      label: 'Audio only (best available)',
      ext: 'm4a',
      height: null,
      sizeBytes: null,
      sizeText: 'size unknown'
    })
  }

  return { title, choices }
}

export interface ExternalProgress {
  readonly downloadedBytes: number
  readonly totalBytes: number | null
  readonly bytesPerSecond: number
  readonly finished: boolean
}

/**
 * One line of yt-dlp's progress, emitted in a shape we asked for.
 *
 * The tool is run with an explicit `--progress-template`, so this parses a
 * format this project defined rather than scraping the human-readable bar. That
 * bar is localised, uses carriage returns rather than newlines, and changes
 * between releases; none of those are things to build on.
 *
 * Returns null for every other line — yt-dlp is chatty, and most of what it
 * says is not progress.
 */
export function parseProgress(line: string): ExternalProgress | null {
  if (!line.startsWith('SLASH|')) return null
  const [, downloaded, total, estimate, speed, status] = line.trim().split('|')

  const asNumber = (raw: string | undefined): number | null => {
    if (raw === undefined || raw === '' || raw === 'NA' || raw === 'None') return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }

  const downloadedBytes = asNumber(downloaded)
  if (downloadedBytes === null) return null

  return {
    downloadedBytes,
    // `total_bytes` is exact and often absent; the estimate is what a fragmented
    // download has. Either is better than a bar that never moves.
    totalBytes: asNumber(total) ?? asNumber(estimate),
    bytesPerSecond: Math.max(0, Math.round(asNumber(speed) ?? 0)),
    finished: (status ?? '').trim() === 'finished'
  }
}

/**
 * The exact arguments used to ask for progress in that shape.
 *
 * Exported so the parser and the caller cannot drift apart: changing the
 * template without changing `parseProgress` would leave a download that runs
 * perfectly and reports nothing, which looks like a hang.
 */
export const PROGRESS_ARGS = [
  '--newline',
  '--progress-template',
  'SLASH|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.status)s'
]
