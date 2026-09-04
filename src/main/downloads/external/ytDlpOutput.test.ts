import { describe, expect, it } from 'vitest'
import { parseFormats, parseProgress, PROGRESS_ARGS, sizeText } from './ytDlpOutput'

/** Shaped like a real `yt-dlp -J` dump for a YouTube watch page. */
const DUMP = {
  title: 'Lil Rome Praba x Tikx Kooda - Atha Arala Daala',
  formats: [
    { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 3_500_000 },
    { format_id: '160', ext: 'mp4', vcodec: 'avc1.4d400c', acodec: 'none', height: 144, filesize: 900_000 },
    { format_id: '133', ext: 'mp4', vcodec: 'avc1.4d400d', acodec: 'none', height: 240, filesize: 1_500_000 },
    { format_id: '135', ext: 'mp4', vcodec: 'avc1.4d401e', acodec: 'none', height: 480, filesize: 8_000_000 },
    { format_id: '136', ext: 'mp4', vcodec: 'avc1.4d401f', acodec: 'none', height: 720, filesize: 20_000_000 },
    { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, filesize: 45_000_000 },
    // Same height, different codec — must not become a second row.
    { format_id: '248', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1080, filesize: 40_000_000 },
    { format_id: '271', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1440, filesize: 90_000_000 },
    { format_id: '313', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 2160, filesize: 200_000_000 },
    { format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, filesize: 12_000_000 }
  ]
}

describe('parseFormats', () => {
  it('lists one row per quality, best first — the way IDM does', () => {
    const { choices } = parseFormats(DUMP)
    expect(choices.map((c) => c.label)).toEqual([
      'MKV file, quality 2160p 4K',
      'MKV file, quality 1440p HD',
      'MP4 file, quality 1080p HD',
      'MP4 file, quality 720p HD',
      'MP4 file, quality 480p',
      'MP4 file, quality 360p',
      'MP4 file, quality 240p',
      'MP4 file, quality 144p',
      'Audio only (best available)'
    ])
  })

  it('collapses several codecs at one height into a single row', () => {
    // yt-dlp reports a dozen entries for one resolution. A picker showing
    // "1080p" nine times is a puzzle, not a choice.
    const { choices } = parseFormats(DUMP)
    expect(choices.filter((c) => c.height === 1080)).toHaveLength(1)
  })

  it('picks MKV where the codec cannot go in an MP4', () => {
    // 1440p and 2160p are VP9 or AV1 on YouTube. Putting those in an MP4 is a
    // file some players will not open, which is why IDM's own list says MKV.
    const { choices } = parseFormats(DUMP)
    expect(choices.find((c) => c.height === 2160)?.ext).toBe('mkv')
    expect(choices.find((c) => c.height === 1080)?.ext).toBe('mp4')
  })

  it('produces a selector, never a URL', () => {
    // The whole robustness of this: yt-dlp resolves it at download time against
    // whatever the site is serving, so a stale address cannot happen.
    const { choices } = parseFormats(DUMP)
    for (const choice of choices) {
      expect(choice.selector).not.toMatch(/^https?:/)
    }
    expect(choices.find((c) => c.height === 1080)?.selector).toBe(
      'bv*[height=1080]+ba/b[height<=1080]'
    )
  })

  it('offers audio on its own when there is any', () => {
    expect(parseFormats(DUMP).choices.at(-1)?.selector).toBe('ba/b')
  })

  it('does not offer audio when the video has none', () => {
    const silent = { title: 'x', formats: [{ vcodec: 'avc1', acodec: 'none', height: 720 }] }
    expect(parseFormats(silent).choices.some((c) => c.height === null)).toBe(false)
  })

  it('keeps the title for the filename', () => {
    expect(parseFormats(DUMP).title).toBe('Lil Rome Praba x Tikx Kooda - Atha Arala Daala')
  })

  it('falls back to the approximate size when the exact one is missing', () => {
    const dump = { formats: [{ vcodec: 'avc1', acodec: 'none', height: 720, filesize_approx: 5_000_000 }] }
    expect(parseFormats(dump).choices[0]?.sizeBytes).toBe(5_000_000)
  })

  it('ignores an entry with no height, which is not a video track', () => {
    const dump = { formats: [{ vcodec: 'avc1', acodec: 'none' }] }
    expect(parseFormats(dump).choices).toEqual([])
  })

  it('survives rubbish', () => {
    // This parses output from a program upgraded independently of this one.
    expect(parseFormats(null).choices).toEqual([])
    expect(parseFormats('not json').choices).toEqual([])
    expect(parseFormats({ formats: 'nope' }).choices).toEqual([])
    expect(parseFormats({ formats: [null, 5, 'x'] }).choices).toEqual([])
  })
})

describe('parseProgress', () => {
  it('reads a line in the shape we asked for', () => {
    const progress = parseProgress('SLASH|1048576|10485760|NA|524288.0|downloading')
    expect(progress).toEqual({
      downloadedBytes: 1048576,
      totalBytes: 10485760,
      bytesPerSecond: 524288,
      finished: false
    })
  })

  it('falls back to the estimate when the exact total is unknown', () => {
    // A fragmented download only ever has the estimate, and a bar that never
    // moves looks like a hang.
    expect(parseProgress('SLASH|100|NA|99999|1000|downloading')?.totalBytes).toBe(99999)
  })

  it('reports the finish', () => {
    expect(parseProgress('SLASH|500|500|NA|0|finished')?.finished).toBe(true)
  })

  it('ignores everything that is not progress', () => {
    // yt-dlp is chatty and most of what it says is not this.
    expect(parseProgress('[youtube] Extracting URL: https://...')).toBeNull()
    expect(parseProgress('[download] Destination: film.mp4')).toBeNull()
    expect(parseProgress('')).toBeNull()
  })

  it('ignores a malformed line rather than reporting zero bytes', () => {
    // Reporting 0 would make a running download look stalled.
    expect(parseProgress('SLASH|NA|NA|NA|NA|downloading')).toBeNull()
  })

  it('never reports a negative speed', () => {
    expect(parseProgress('SLASH|100|200|NA|-5|downloading')?.bytesPerSecond).toBe(0)
  })

  it('is asked for in exactly the shape it parses', () => {
    // Changing the template without changing the parser leaves a download that
    // runs perfectly and reports nothing, which reads as a hang.
    const template = PROGRESS_ARGS[PROGRESS_ARGS.indexOf('--progress-template') + 1] ?? ''
    expect(template.startsWith('SLASH|')).toBe(true)
    expect(template.split('|')).toHaveLength(6)
  })
})

describe('sizeText', () => {
  it('is coarse on purpose', () => {
    expect(sizeText(45_000_000)).toBe('42.9 MB')
    expect(sizeText(null)).toBe('size unknown')
    expect(sizeText(0)).toBe('size unknown')
  })
})

describe('quality labels', () => {
  it("uses the site's own tier name when it gave one", () => {
    // A video that is not 16:9 reports true pixel heights — 546, 364, 182 —
    // which are accurate and read as broken next to "480p". YouTube already
    // calls those tiers 480p and 360p.
    const { choices } = parseFormats({
      formats: [
        { vcodec: 'avc1', acodec: 'none', height: 546, format_note: '480p' },
        { vcodec: 'avc1', acodec: 'none', height: 364, format_note: '360p' }
      ]
    })
    expect(choices.map((c) => c.label)).toEqual([
      'MP4 file, quality 480p',
      'MP4 file, quality 360p'
    ])
  })

  it('falls back to the height when there is no tier name', () => {
    const { choices } = parseFormats({ formats: [{ vcodec: 'avc1', acodec: 'none', height: 1080 }] })
    expect(choices[0]?.label).toBe('MP4 file, quality 1080p HD')
  })

  it('ignores a format_note that is not a quality', () => {
    const { choices } = parseFormats({
      formats: [{ vcodec: 'avc1', acodec: 'none', height: 720, format_note: 'DASH video' }]
    })
    expect(choices[0]?.label).toBe('MP4 file, quality 720p HD')
  })
})
