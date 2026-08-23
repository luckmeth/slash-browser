import { describe, it, expect } from 'vitest'
import {
  containerFor,
  estimateBytes,
  isMasterPlaylist,
  parseAttributes,
  parseMaster,
  parseMedia,
  resolveUri
} from './hlsPlaylist'

const BASE = 'https://cdn.example.com/video/master.m3u8'

describe('parseAttributes', () => {
  it('keeps a quoted value containing commas intact', () => {
    // Splitting the line on commas is the mistake that makes every variant's
    // codec list wrong, and it looks fine until you check one.
    const attributes = parseAttributes(
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720'
    )
    expect(attributes['CODECS']).toBe('avc1.4d401f,mp4a.40.2')
    expect(attributes['BANDWIDTH']).toBe('1280000')
    expect(attributes['RESOLUTION']).toBe('1280x720')
  })

  it('reads an unquoted value', () => {
    expect(parseAttributes('#EXT-X-KEY:METHOD=AES-128')['METHOD']).toBe('AES-128')
  })
})

describe('resolveUri', () => {
  it('resolves a relative segment against the playlist', () => {
    expect(resolveUri('720/seg1.ts', BASE)).toBe('https://cdn.example.com/video/720/seg1.ts')
  })

  it('leaves an absolute URL alone', () => {
    expect(resolveUri('https://other.example.com/a.ts', BASE)).toBe('https://other.example.com/a.ts')
  })

  it('resolves a root-relative path', () => {
    expect(resolveUri('/hls/a.ts', BASE)).toBe('https://cdn.example.com/hls/a.ts')
  })
})

describe('parseMaster', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    '360p.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
    '1080p.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720',
    '720p.m3u8'
  ].join('\n')

  it('recognises a master playlist', () => {
    expect(isMasterPlaylist(master)).toBe(true)
    expect(isMasterPlaylist('#EXTM3U\n#EXTINF:6,\na.ts')).toBe(false)
  })

  it('returns every quality, best first', () => {
    const variants = parseMaster(master, BASE)
    expect(variants.map((v) => v.resolution)).toEqual(['1920x1080', '1280x720', '640x360'])
  })

  it('resolves each variant against the master', () => {
    expect(parseMaster(master, BASE)[0]?.url).toBe('https://cdn.example.com/video/1080p.m3u8')
  })

  it('finds the URI across blank lines and unrelated tags', () => {
    // Encoders put these between the tag and its URI more often than the spec
    // suggests, and reading "the next line" literally loses the variant.
    const awkward = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      '',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      'v/360p.m3u8'
    ].join('\n')
    expect(parseMaster(awkward, BASE)[0]?.url).toBe('https://cdn.example.com/video/v/360p.m3u8')
  })

  it('falls back to average bandwidth when peak is absent', () => {
    const text = '#EXTM3U\n#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=900000\na.m3u8'
    expect(parseMaster(text, BASE)[0]?.bandwidth).toBe(900_000)
  })

  it('returns nothing for a playlist with no variants', () => {
    expect(parseMaster('#EXTM3U', BASE)).toEqual([])
  })
})

describe('parseMedia', () => {
  const finished = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.006,',
    'seg1.ts',
    '#EXTINF:6.006,',
    'seg2.ts',
    '#EXTINF:3.0,',
    'seg3.ts',
    '#EXT-X-ENDLIST'
  ].join('\n')

  it('reads every segment in order', () => {
    const media = parseMedia(finished, BASE)
    expect(media.segments.map((s) => s.url)).toEqual([
      'https://cdn.example.com/video/seg1.ts',
      'https://cdn.example.com/video/seg2.ts',
      'https://cdn.example.com/video/seg3.ts'
    ])
    expect(media.refusal).toBeNull()
  })

  it('totals the duration', () => {
    expect(parseMedia(finished, BASE).durationSeconds).toBeCloseTo(15.012, 3)
  })

  it('keeps the initialisation segment, which must be written first', () => {
    // Without it a fragmented MP4 downloads perfectly and will not open.
    const fmp4 = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4,',
      'seg1.m4s',
      '#EXT-X-ENDLIST'
    ].join('\n')
    expect(parseMedia(fmp4, BASE).initSegment).toBe('https://cdn.example.com/video/init.mp4')
  })

  it('reads a byte-range segment', () => {
    const ranged = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXTINF:4,',
      '#EXT-X-BYTERANGE:75232@0',
      'all.ts',
      '#EXT-X-ENDLIST'
    ].join('\n')
    expect(parseMedia(ranged, BASE).segments[0]?.byteRange).toEqual({ length: 75232, offset: 0 })
  })

  it('refuses an encrypted stream, and says so', () => {
    const encrypted = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:6,',
      'seg1.ts',
      '#EXT-X-ENDLIST'
    ].join('\n')
    expect(parseMedia(encrypted, BASE).refusal).toContain('encrypted')
  })

  it('accepts METHOD=NONE, which is not encryption', () => {
    const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-KEY:METHOD=NONE', '#EXTINF:6,', 'a.ts', '#EXT-X-ENDLIST'].join('\n')
    expect(parseMedia(text, BASE).refusal).toBeNull()
  })

  it('refuses a live stream rather than picking a moment to stop', () => {
    // Downloading something with no end is recording, which is a different
    // feature and should not happen by pressing a button labelled Download.
    const live = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6,', 'seg1.ts'].join('\n')
    expect(parseMedia(live, BASE).refusal).toContain('live stream')
  })

  it('refuses an empty playlist', () => {
    expect(parseMedia('#EXTM3U\n#EXT-X-ENDLIST', BASE).refusal).toContain('no segments')
  })
})

describe('estimateBytes', () => {
  it('turns bits per second and seconds into bytes', () => {
    expect(estimateBytes(8_000_000, 60)).toBe(60_000_000)
  })

  it('declines to guess without both numbers', () => {
    expect(estimateBytes(0, 60)).toBeNull()
    expect(estimateBytes(8_000_000, 0)).toBeNull()
  })
})

describe('containerFor', () => {
  const seg = (url: string) => [{ url, duration: 6, byteRange: null }]

  it('recognises MPEG-TS, which concatenates directly', () => {
    expect(containerFor(seg('https://x.com/a.ts'), false)).toBe('ts')
  })

  it('recognises fragmented MP4 when there is an init segment', () => {
    expect(containerFor(seg('https://x.com/a.m4s'), true)).toBe('mp4')
  })

  it('refuses fragmented MP4 with no init segment', () => {
    // Concatenating those gives a file that downloads perfectly and will not
    // open, which is worse than refusing.
    expect(containerFor(seg('https://x.com/a.m4s'), false)).toBeNull()
  })

  it('treats an extensionless segment with an init as fragmented MP4', () => {
    expect(containerFor(seg('https://cdn.x.com/seg?id=4'), true)).toBe('mp4')
  })

  it('says nothing when there are no segments', () => {
    expect(containerFor([], false)).toBeNull()
  })
})
