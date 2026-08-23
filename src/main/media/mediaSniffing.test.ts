import { describe, it, expect } from 'vitest'
import {
  classifyMedia,
  formatSize,
  rankCandidates,
  suggestedFilename,
  sniffNote,
  toDownloadable,
  containerOf,
  MediaLedger,
  type SniffedMedia
} from './mediaSniffing'

const BIG = 50_000_000

describe('classifyMedia — what counts as media', () => {
  it('recognises a complete video file', () => {
    const found = classifyMedia('https://cdn.example.com/film.mp4', 'video/mp4', BIG)
    expect(found).toMatchObject({ kind: 'file', label: 'Video file' })
  })

  it('recognises audio', () => {
    expect(classifyMedia('https://x.com/a.mp3', 'audio/mpeg', BIG)?.label).toBe('Audio file')
  })

  it('sees through a query string', () => {
    // Extensions hide behind tokens and signatures on every real CDN.
    const found = classifyMedia('https://cdn.x.com/film.mp4?token=abc&expires=1', '', BIG)
    expect(found?.kind).toBe('file')
  })

  it('recognises HLS and DASH manifests', () => {
    expect(classifyMedia('https://x.com/master.m3u8', '', null)?.label).toBe('HLS stream')
    expect(classifyMedia('https://x.com/manifest.mpd', '', null)?.label).toBe('DASH stream')
    expect(classifyMedia('https://x.com/p', 'application/vnd.apple.mpegurl', null)?.kind).toBe(
      'stream'
    )
  })

  it('trusts the content type when the path says nothing', () => {
    expect(classifyMedia('https://x.com/stream/9f2a', 'video/mp4', BIG)?.kind).toBe('file')
  })
})

describe('classifyMedia — what must be left out', () => {
  it('drops stream segments', () => {
    // A two-hour film is thousands of these. Listing them makes the panel
    // unusable, and downloading one gives somebody four unplayable seconds.
    expect(classifyMedia('https://x.com/seg-0001.ts', 'video/mp2t', 500_000)).toBeNull()
    expect(classifyMedia('https://x.com/chunk.m4s', 'video/mp4', 500_000)).toBeNull()
  })

  it('drops responses too small to be the thing anybody wants', () => {
    // Posters, beacons and probes. Offering them buries the real file.
    expect(classifyMedia('https://x.com/preview.mp4', 'video/mp4', 40_000)).toBeNull()
  })

  it('keeps a file whose size the server never stated', () => {
    // Unknown is not the same as small, and chunked responses report nothing.
    expect(classifyMedia('https://x.com/film.mp4', 'video/mp4', null)?.kind).toBe('file')
  })

  it('ignores anything that is not media', () => {
    expect(classifyMedia('https://x.com/app.js', 'application/javascript', BIG)).toBeNull()
    expect(classifyMedia('https://x.com/a.png', 'image/png', BIG)).toBeNull()
  })

  it('ignores non-http schemes', () => {
    expect(classifyMedia('blob:https://x.com/abc', 'video/mp4', BIG)).toBeNull()
    expect(classifyMedia('data:video/mp4;base64,AAAA', 'video/mp4', BIG)).toBeNull()
  })
})

describe('classifyMedia — DRM', () => {
  it('labels a protected stream rather than offering it', () => {
    // Recognised so it can be refused with a reason. A download that produces
    // an unplayable file is worse than an honest refusal.
    for (const url of [
      'https://x.com/widevine/license',
      'https://x.com/playready/rights',
      'https://licenseserver.example.com/get'
    ]) {
      expect(classifyMedia(url, 'application/octet-stream', BIG)?.kind).toBe('protected')
    }
  })

  it('treats protection as decisive, whatever the extension says', () => {
    expect(classifyMedia('https://drmtoday.com/a.mp4', 'video/mp4', BIG)?.kind).toBe('protected')
  })
})

describe('rankCandidates', () => {
  const make = (over: Partial<SniffedMedia>): SniffedMedia => ({
    url: 'https://x.com/a.mp4',
    kind: 'file',
    media: 'video',
    label: 'Video file',
    size: 1000,
    contentType: 'video/mp4',
    ...over
  })

  it('puts a complete file above a manifest', () => {
    // A file downloads to something playable without assembly.
    const ranked = rankCandidates([
      make({ url: 'https://x.com/m.m3u8', kind: 'stream', size: null }),
      make({ url: 'https://x.com/film.mp4', size: 900 })
    ])
    expect(ranked[0]?.kind).toBe('file')
  })

  it('puts the bigger file first', () => {
    // The small one is usually the advert that played before the feature.
    const ranked = rankCandidates([
      make({ url: 'https://x.com/ad.mp4', size: 2_000_000 }),
      make({ url: 'https://x.com/film.mp4', size: 900_000_000 })
    ])
    expect(ranked[0]?.url).toContain('film')
  })

  it('puts protected streams last', () => {
    const ranked = rankCandidates([
      make({ url: 'https://x.com/drm', kind: 'protected' }),
      make({ url: 'https://x.com/film.mp4' })
    ])
    expect(ranked[ranked.length - 1]?.kind).toBe('protected')
  })

  it('deduplicates, keeping whichever knows its size', () => {
    // The same URL arrives twice, once from a range request reporting nothing.
    const ranked = rankCandidates([
      make({ url: 'https://x.com/film.mp4', size: null }),
      make({ url: 'https://x.com/film.mp4', size: 5000 })
    ])
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.size).toBe(5000)
  })
})

describe('formatSize', () => {
  it('reads the way a person would say it', () => {
    expect(formatSize(900)).toBe('900 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(50_000_000)).toBe('48 MB')
  })

  it('says so when the server never told us', () => {
    expect(formatSize(null)).toBe('unknown size')
    expect(formatSize(0)).toBe('unknown size')
  })
})

describe('suggestedFilename', () => {
  it('uses the name in the path', () => {
    expect(suggestedFilename('https://x.com/movies/film.mp4', 'file')).toBe('film.mp4')
  })

  it('strips a query string', () => {
    expect(suggestedFilename('https://x.com/film.mp4?token=a', 'file')).toBe('film.mp4')
  })

  it('names a stream by date, since a manifest name is not the video', () => {
    expect(suggestedFilename('https://x.com/master.m3u8', 'stream')).toMatch(/^video-.*\.mp4$/)
  })

  it('never returns an empty name', () => {
    // A download with no name is one nobody finds again.
    expect(suggestedFilename('https://x.com/', 'file')).toMatch(/^video-.*\.mp4$/)
    expect(suggestedFilename('https://x.com/9f2a', 'file')).toMatch(/^video-.*\.mp4$/)
  })
})

describe('media kind', () => {
  it('separates audio from video, since the panel groups by it', () => {
    expect(classifyMedia('https://x.com/a.mp3', 'audio/mpeg', BIG)?.media).toBe('audio')
    expect(classifyMedia('https://x.com/a.mp4', 'video/mp4', BIG)?.media).toBe('video')
  })

  it('leaves it unset for a manifest or a licence, which are neither', () => {
    expect(classifyMedia('https://x.com/m.m3u8', '', null)?.media).toBeNull()
    expect(classifyMedia('https://x.com/widevine/l', '', null)?.media).toBeNull()
  })
})

describe('containerOf', () => {
  it('reads the extension when there is one', () => {
    expect(containerOf('https://x.com/film.webm', 'video/webm')).toBe('webm')
  })

  it('falls back to the content type', () => {
    expect(containerOf('https://x.com/stream/9f2a', 'video/mp4')).toBe('mp4')
  })

  it('says nothing rather than guessing', () => {
    expect(containerOf('https://x.com/stream/9f2a', '')).toBeNull()
  })
})

describe('toDownloadable', () => {
  const found = (over: Partial<SniffedMedia>): SniffedMedia => ({
    url: 'https://x.com/film.mp4',
    kind: 'file',
    media: 'video',
    label: 'Video file',
    size: 50_000_000,
    contentType: 'video/mp4',
    ...over
  })

  it('offers complete files', () => {
    const [first] = toDownloadable([found({})])
    expect(first).toMatchObject({ url: 'https://x.com/film.mp4', kind: 'video', container: 'mp4' })
    expect(first?.label).toBe('film.mp4 · 48 MB')
  })

  it('offers nothing for a manifest or a protected stream', () => {
    // A button that produces an unplayable file is worse than no button.
    expect(toDownloadable([found({ kind: 'stream', media: null })])).toEqual([])
    expect(toDownloadable([found({ kind: 'protected', media: null })])).toEqual([])
  })

  it('keeps the ranking, so the feature is above the advert', () => {
    const list = toDownloadable([
      found({ url: 'https://x.com/ad.mp4', size: 1_000_000 }),
      found({ url: 'https://x.com/film.mp4', size: 900_000_000 })
    ])
    expect(list[0]?.url).toContain('film')
  })
})

describe('sniffNote', () => {
  const one = (kind: SniffedMedia['kind']): SniffedMedia => ({
    url: 'https://x.com/a',
    kind,
    media: null,
    label: '',
    size: null,
    contentType: ''
  })

  it('says nothing when there is something to download', () => {
    expect(sniffNote([one('file')])).toBeNull()
    expect(sniffNote([])).toBeNull()
  })

  it('names encryption as the reason, rather than looking broken', () => {
    expect(sniffNote([one('protected')])).toContain('encrypted')
  })

  it('names segmented delivery as the reason', () => {
    expect(sniffNote([one('stream')])).toContain('adaptive stream')
  })

  it('prefers the encryption explanation, which is the harder limit', () => {
    // A protected stream is also segmented; saying "segments" would imply the
    // only obstacle is effort.
    expect(sniffNote([one('stream'), one('protected')])).toContain('encrypted')
  })
})

describe('MediaLedger', () => {
  const item = (url: string, size = 1000): SniffedMedia => ({
    url,
    kind: 'file',
    media: 'video',
    label: 'Video file',
    size,
    contentType: 'video/mp4'
  })

  it('keeps tabs apart', () => {
    const ledger = new MediaLedger()
    ledger.record(1, item('https://x.com/a.mp4'))
    ledger.record(2, item('https://x.com/b.mp4'))
    expect(ledger.forTab(1).map((m) => m.url)).toEqual(['https://x.com/a.mp4'])
  })

  it('answers with nothing for a tab that has fetched nothing', () => {
    expect(new MediaLedger().forTab(99)).toEqual([])
  })

  it('drops the previous video once the new one has been seen', () => {
    const ledger = new MediaLedger()
    ledger.record(1, item('https://x.com/first.mp4'))
    ledger.advance(1)
    ledger.record(1, item('https://x.com/second.mp4'))
    expect(ledger.forTab(1).map((m) => m.url)).toEqual(['https://x.com/second.mp4'])
  })

  it('still answers with the previous video until the new one arrives', () => {
    // YouTube's route change and the new video's first request race. Clearing on
    // the route change alone would empty the panel exactly when it is asked.
    const ledger = new MediaLedger()
    ledger.record(1, item('https://x.com/first.mp4'))
    ledger.advance(1)
    expect(ledger.forTab(1).map((m) => m.url)).toEqual(['https://x.com/first.mp4'])
  })

  it('handles a request that lands just before the route change', () => {
    const ledger = new MediaLedger()
    ledger.record(1, item('https://x.com/first.mp4'))
    ledger.record(1, item('https://x.com/second.mp4'))
    ledger.advance(1)
    ledger.advance(1)
    // Nothing in the newest two generations; the most recent that has anything wins.
    expect(ledger.forTab(1)).toHaveLength(2)
  })

  it('caps what one tab can accumulate', () => {
    const ledger = new MediaLedger()
    for (let i = 0; i < MediaLedger.MAX_PER_TAB + 20; i += 1) {
      ledger.record(1, item(`https://x.com/${i}.mp4`))
    }
    expect(ledger.forTab(1).length).toBeLessThanOrEqual(MediaLedger.MAX_PER_TAB)
  })

  it('forgets a closed tab', () => {
    const ledger = new MediaLedger()
    ledger.record(1, item('https://x.com/a.mp4'))
    ledger.forget(1)
    expect(ledger.forTab(1)).toEqual([])
  })
})
