import { describe, it, expect } from 'vitest'
import {
  analyseFormats,
  choicesFrom,
  formatsNote,
  extensionFor,
  isExtractablePage,
  safeTitle,
  tracksIn,
  type RawFormat
} from './pageFormats'

const progressive = (over: Partial<RawFormat> = {}): RawFormat => ({
  url: 'https://rr3---sn-x.googlevideo.com/videoplayback?itag=18',
  mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
  qualityLabel: '360p',
  contentLength: '12000000',
  ...over
})

const videoOnly = (over: Partial<RawFormat> = {}): RawFormat => ({
  url: 'https://rr3---sn-x.googlevideo.com/videoplayback?itag=137',
  mimeType: 'video/mp4; codecs="avc1.640028"',
  qualityLabel: '1080p',
  contentLength: '90000000',
  ...over
})

const audioOnly = (over: Partial<RawFormat> = {}): RawFormat => ({
  url: 'https://rr3---sn-x.googlevideo.com/videoplayback?itag=140',
  mimeType: 'audio/mp4; codecs="mp4a.40.2"',
  contentLength: '3000000',
  ...over
})

describe('tracksIn', () => {
  it('reads both tracks from a two-codec string', () => {
    expect(tracksIn('video/mp4; codecs="avc1.42001E, mp4a.40.2"')).toEqual({
      video: true,
      audio: true
    })
  })

  it('reads a video-only adaptive format', () => {
    expect(tracksIn('video/mp4; codecs="avc1.640028"')).toEqual({ video: true, audio: false })
  })

  it('reads an audio-only adaptive format', () => {
    expect(tracksIn('audio/webm; codecs="opus"')).toEqual({ video: false, audio: true })
  })

  it('recognises modern codecs', () => {
    expect(tracksIn('video/webm; codecs="vp9"').video).toBe(true)
    expect(tracksIn('video/mp4; codecs="av01.0.08M.08"').video).toBe(true)
  })

  it('falls back to the type when there is no codec string', () => {
    expect(tracksIn('video/mp4')).toEqual({ video: true, audio: false })
    expect(tracksIn('audio/mpeg')).toEqual({ video: false, audio: true })
  })
})

describe('choicesFrom', () => {
  it('offers a progressive format as a complete file', () => {
    const [first] = choicesFrom({ formats: [progressive()] })
    expect(first).toMatchObject({ complete: true, hasVideo: true, hasAudio: true })
    expect(first?.label).toBe('360p')
    expect(first?.size).toBe(12_000_000)
  })

  it('puts a complete file above a larger half', () => {
    // One click producing a playable video is the whole point. A 1080p
    // video-only stream is bigger and worse.
    const choices = choicesFrom({
      formats: [progressive()],
      adaptiveFormats: [videoOnly(), audioOnly()]
    })
    expect(choices[0]?.complete).toBe(true)
    expect(choices[0]?.label).toBe('360p')
  })

  it('says out loud that an adaptive video has no sound', () => {
    // Downloading one and getting a silent film is how somebody concludes the
    // browser is broken.
    const choices = choicesFrom({ adaptiveFormats: [videoOnly()] })
    expect(choices[0]?.label).toBe('1080p · no sound')
    expect(choices[0]?.complete).toBe(false)
  })

  it('labels audio-only plainly', () => {
    expect(choicesFrom({ adaptiveFormats: [audioOnly()] })[0]?.label).toBe('Audio only')
  })

  it('ranks video above audio, then bigger first', () => {
    const choices = choicesFrom({
      adaptiveFormats: [
        audioOnly(),
        videoOnly({ url: 'https://x.com/a?itag=136', qualityLabel: '720p', contentLength: '40000000' }),
        videoOnly()
      ]
    })
    expect(choices.map((c) => c.label)).toEqual(['1080p · no sound', '720p · no sound', 'Audio only'])
  })

  it('skips a format whose address needs the page to build it', () => {
    // signatureCipher means the URL must be assembled by running YouTube's own
    // signature code. Offering a button that produces a 403 is worse than
    // offering one fewer option.
    const choices = choicesFrom({
      formats: [{ signatureCipher: 's=abc&url=https%3A%2F%2Fx.com', mimeType: 'video/mp4' }]
    })
    expect(choices).toEqual([])
  })

  it('skips anything that is not an http address', () => {
    expect(choicesFrom({ formats: [progressive({ url: 'javascript:alert(1)' })] })).toEqual([])
    expect(choicesFrom({ formats: [progressive({ url: '' })] })).toEqual([])
  })

  it('deduplicates a format listed in both arrays', () => {
    expect(choicesFrom({ formats: [progressive()], adaptiveFormats: [progressive()] })).toHaveLength(1)
  })

  it('returns nothing rather than throwing on rubbish', () => {
    // The shape is somebody else's and changes without warning.
    expect(choicesFrom(null)).toEqual([])
    expect(choicesFrom(undefined)).toEqual([])
    expect(choicesFrom({})).toEqual([])
    expect(choicesFrom({ formats: 'not an array' })).toEqual([])
    expect(choicesFrom({ formats: [{}, { url: 5 }] })).toEqual([])
  })

  it('survives a missing quality label', () => {
    const choices = choicesFrom({ formats: [progressive({ qualityLabel: undefined, height: 720 })] })
    expect(choices[0]?.label).toBe('720p')
  })
})

describe('isExtractablePage', () => {
  it('recognises a watch page', () => {
    expect(isExtractablePage('https://www.youtube.com/watch?v=abc&list=x')).toBe(true)
  })

  it('recognises shorts and the short link', () => {
    expect(isExtractablePage('https://www.youtube.com/shorts/abc')).toBe(true)
    expect(isExtractablePage('https://youtu.be/abc')).toBe(true)
  })

  it('does not offer on pages with no single video', () => {
    // A chip over a grid of thumbnails points at nothing.
    expect(isExtractablePage('https://www.youtube.com/')).toBe(false)
    expect(isExtractablePage('https://www.youtube.com/feed/subscriptions')).toBe(false)
  })

  it('is not fooled by a lookalike host', () => {
    expect(isExtractablePage('https://youtube.com.evil.test/watch?v=a')).toBe(false)
    expect(isExtractablePage('https://notyoutube.com/watch?v=a')).toBe(false)
  })

  it('says no rather than throwing on a non-URL', () => {
    expect(isExtractablePage('')).toBe(false)
    expect(isExtractablePage('about:blank')).toBe(false)
  })
})

describe('safeTitle', () => {
  it('strips characters Windows will not accept in a filename', () => {
    expect(safeTitle('A/B: "C" <D>|E?')).toBe('AB C DE')
  })

  it('falls back rather than returning empty', () => {
    // YouTube's own URLs are all called `videoplayback`, which is a download
    // nobody ever finds again.
    expect(safeTitle('   ')).toBe('video')
    expect(safeTitle('///')).toBe('video')
  })

  it('caps the length', () => {
    expect(safeTitle('x'.repeat(400)).length).toBe(120)
  })
})

describe('extensionFor', () => {
  it('names video and audio containers apart', () => {
    expect(extensionFor('video/mp4', true)).toBe('mp4')
    expect(extensionFor('audio/mp4', false)).toBe('m4a')
    expect(extensionFor('video/webm', true)).toBe('webm')
    expect(extensionFor('audio/webm', false)).toBe('weba')
  })

  it('guesses something playable when the type is unknown', () => {
    expect(extensionFor('', true)).toBe('mp4')
  })
})

describe('analyseFormats and formatsNote', () => {
  it('counts formats whose address is signed rather than given', () => {
    const analysis = analyseFormats({
      formats: [{ signatureCipher: 's=a&url=https%3A%2F%2Fx', mimeType: 'video/mp4' }],
      adaptiveFormats: [{ cipher: 's=b', mimeType: 'video/mp4' }]
    })
    expect(analysis.choices).toEqual([])
    expect(analysis.signed).toBe(2)
  })

  it('says which limit was hit rather than looking broken', () => {
    // "This page lists no media" and "every address here is signed" are
    // different facts, and the second one sends nobody off to file a bug.
    const note = formatsNote(analyseFormats({ formats: [{ signatureCipher: 's=a' }] }))
    expect(note).toContain('signed addresses')
  })

  it('says nothing when a complete file is on offer', () => {
    expect(formatsNote(analyseFormats({ formats: [progressive()] }))).toBeNull()
  })

  it('warns when every option is one half of a pair', () => {
    const note = formatsNote(analyseFormats({ adaptiveFormats: [videoOnly(), audioOnly()] }))
    expect(note).toContain('does not combine them')
  })

  it('has nothing to explain about a page with no media at all', () => {
    // Distinct from the signed case: this one falls through to the network
    // observer, which may know better.
    expect(formatsNote(analyseFormats({}))).toBeNull()
  })

  it('still marks the first array as progressive after the two are joined', () => {
    // The `index < progressive.length` trick is load-bearing: get it wrong and
    // every adaptive format claims to be a complete file.
    const analysis = analyseFormats({ formats: [progressive()], adaptiveFormats: [videoOnly()] })
    expect(analysis.choices.find((c) => c.label === '360p')?.complete).toBe(true)
    expect(analysis.choices.find((c) => c.label.startsWith('1080p'))?.complete).toBe(false)
  })
})
