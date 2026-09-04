import { describe, expect, it } from 'vitest'
import { stripPlayerResponse, AD_FIELDS } from './playerResponseFilter'

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

const decode = (body: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as Record<string, unknown>

const playerResponse = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  responseContext: { visitorData: 'x' },
  streamingData: { formats: [{ itag: 18 }] },
  videoDetails: { videoId: 'abc', title: 'A song' },
  ...extra
})

describe('what it removes', () => {
  it('takes out every ad field it knows', () => {
    const body = encode(
      playerResponse({
        adPlacements: [{ a: 1 }],
        playerAds: [{ b: 2 }],
        adSlots: [{ c: 3 }],
        adBreakHeartbeatParams: 'xyz'
      })
    )

    const out = stripPlayerResponse(body, true)
    expect(out.body).not.toBeNull()
    expect(out.removed.sort()).toEqual([...AD_FIELDS].sort())

    const after = decode(out.body!)
    for (const field of AD_FIELDS) expect(after[field]).toBeUndefined()
  })

  it('reaches the server-stitched config, which is not at the top level', () => {
    const body = encode(
      playerResponse({ adPlacements: [{ a: 1 }], playerConfig: { ssap: { on: true }, audio: {} } })
    )
    const out = stripPlayerResponse(body, true)
    const after = decode(out.body!)
    expect((after.playerConfig as Record<string, unknown>).ssap).toBeUndefined()
    // The rest of playerConfig is left alone: it configures playback.
    expect((after.playerConfig as Record<string, unknown>).audio).toEqual({})
    expect(out.removed).toContain('playerConfig.ssap')
  })

  it('leaves everything the player needs to play the video', () => {
    const body = encode(playerResponse({ adPlacements: [{ a: 1 }] }))
    const after = decode(stripPlayerResponse(body, true).body!)
    expect(after.streamingData).toEqual({ formats: [{ itag: 18 }] })
    expect((after.videoDetails as Record<string, unknown>).videoId).toBe('abc')
    expect(after.responseContext).toEqual({ visitorData: 'x' })
  })
})

describe('when it must not interfere', () => {
  // Every one of these returns null so the caller continues the request
  // untouched. A paused request that is never continued hangs the page, which
  // is a far worse failure than an advert.
  it('leaves a response with no ad fields alone', () => {
    expect(stripPlayerResponse(encode(playerResponse()), true).body).toBeNull()
  })

  it('leaves a body that is not JSON alone', () => {
    const body = Buffer.from('adPlacements but not JSON', 'utf8').toString('base64')
    expect(stripPlayerResponse(body, true).body).toBeNull()
  })

  it('leaves truncated JSON alone rather than serving half a response', () => {
    const half = JSON.stringify(playerResponse({ adPlacements: [{ a: 1 }] })).slice(0, 40)
    expect(stripPlayerResponse(Buffer.from(half).toString('base64'), true).body).toBeNull()
  })

  it('handles a plain-text body when the debugger says it is not encoded', () => {
    const text = JSON.stringify(playerResponse({ adPlacements: [{ a: 1 }] }))
    const out = stripPlayerResponse(text, false)
    expect(out.body).not.toBeNull()
    expect(decode(out.body!).adPlacements).toBeUndefined()
  })

  it('does not parse a large body that cannot contain an ad field', () => {
    // The cheap reject: a response naming none of the fields is passed over
    // without being parsed at all, which is what keeps this off the hot path.
    const big = encode({ streamingData: { x: 'y'.repeat(50_000) } })
    expect(stripPlayerResponse(big, true).body).toBeNull()
  })
})
