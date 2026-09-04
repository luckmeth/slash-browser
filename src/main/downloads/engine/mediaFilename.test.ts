import { describe, expect, it } from 'vitest'
import { mediaFilename } from './mediaFilename'
import { categorise } from './planning'

describe('mediaFilename', () => {
  it('uses the page title when the URL names the endpoint, not the film', () => {
    // The shipped bug: a two-hour film arrived called `index.ts`.
    expect(
      mediaFilename(
        'Doctor Strange in the Multiverse of Madness',
        'https://zenithofzircon.space/hls/1080/abc/index.m3u8'
      )
    ).toBe('Doctor Strange in the Multiverse of Madness')
  })

  it.each(['index.m3u8', 'master.m3u8', 'playlist.m3u8', 'videoplayback', 'chunklist.m3u8', 'seg1.ts'])(
    'treats %s as an endpoint name rather than a title',
    (basename) => {
      expect(mediaFilename('Real Title', `https://host/a/b/${basename}`)).toBe('Real Title')
    }
  )

  it('prefers a URL that genuinely names the file', () => {
    // The most specific thing available beats any page title.
    expect(
      mediaFilename('Watch free online', 'https://host/files/The.Matrix.1999.1080p.mp4')
    ).toBe('The.Matrix.1999.1080p.mp4')
  })

  it('strips the site name off the end of a title', () => {
    expect(mediaFilename('Lil Rome Praba - Atha Arala Daala - YouTube', 'https://host/index.m3u8')).toBe(
      'Lil Rome Praba - Atha Arala Daala'
    )
  })

  it('falls back when there is neither a title nor a usable path', () => {
    expect(mediaFilename('', 'https://host/index.m3u8')).toBe('index.m3u8')
    expect(mediaFilename('', 'https://host/')).toBe('video')
  })

  it('caps a very long title, because the whole path has to fit', () => {
    expect(mediaFilename('x'.repeat(400), 'https://host/index.m3u8').length).toBeLessThanOrEqual(120)
  })

  it('survives an unparseable URL', () => {
    expect(mediaFilename('Title', 'not a url')).toBe('Title')
  })

  it('adds no extension — the container is not known yet', () => {
    // `withExtension` puts it on after the manifest has been read. Guessing one
    // here would produce `film.mp4` for something that is MPEG-TS.
    expect(mediaFilename('Film', 'https://host/index.m3u8')).not.toContain('.')
  })
})

describe('categorise', () => {
  it('files a transport stream as video', () => {
    // `.ts` fell through to "other", so an assembled HLS film landed in the
    // wrong folder and under the wrong filter in the downloads panel.
    expect(categorise('film.ts', null)).toBe('video')
  })

  it('still recognises the ordinary containers', () => {
    expect(categorise('a.mp4', null)).toBe('video')
    expect(categorise('a.mkv', null)).toBe('video')
    expect(categorise('a.m4s', null)).toBe('video')
  })

  it('shelves any .ts as video, and that is a deliberate trade', () => {
    // `.ts` is genuinely ambiguous: transport stream or TypeScript source.
    // Extension is checked before MIME, so this wins either way, and a
    // TypeScript file downloaded from the web is filed under Video.
    //
    // Accepted knowingly. In a browser a `.ts` download is a transport stream
    // far more often than it is source, and the alternative left every
    // assembled HLS film in "other" — out of the Video folder and out of the
    // video filter in the downloads panel, which is where somebody who just
    // downloaded a film goes looking for it.
    expect(categorise('module.ts', 'text/plain')).toBe('video')
  })
})
