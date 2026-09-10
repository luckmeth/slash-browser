import { describe, expect, it } from 'vitest'
import { stripPlayerResponse, AD_FIELDS, pruneAdFields, PLAYER_URL_PATTERNS } from './playerResponseFilter'

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


describe('nested ad fields — the shape that let adverts through', () => {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
  const decode = (body: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as Record<string, unknown>

  it('strips adPlacements nested under playerResponse', () => {
    // The exact body that played an advert: reaching a watch page by clicking a
    // related video is an in-page navigation, and its player data arrives
    // nested. The old top-level-only strip matched nothing here and served it.
    const out = stripPlayerResponse(
      encode({
        responseContext: {},
        playerResponse: {
          videoDetails: { videoId: 'x' },
          adPlacements: [{ a: 1 }],
          playerAds: [{ b: 2 }]
        }
      }),
      true
    )

    expect(out.body).not.toBeNull()
    const player = decode(out.body!)['playerResponse'] as Record<string, unknown>
    expect(player['adPlacements']).toBeUndefined()
    expect(player['playerAds']).toBeUndefined()
    // The response itself must survive: swallowing it breaks playback.
    expect(player['videoDetails']).toBeDefined()
  })

  it('names the path it removed, not just the field', () => {
    const out = stripPlayerResponse(
      encode({ playerResponse: { adPlacements: [{ a: 1 }] } }),
      true
    )
    expect(out.removed).toContain('playerResponse.adPlacements')
  })

  it('reaches ad fields inside arrays', () => {
    const out = stripPlayerResponse(
      encode({ contents: [{ slot: { adSlots: [{ a: 1 }] } }, { slot: {} }] }),
      true
    )
    expect(out.body).not.toBeNull()
    const contents = decode(out.body!)['contents'] as Record<string, unknown>[]
    const slot = contents[0]!['slot'] as Record<string, unknown>
    expect(slot['adSlots']).toBeUndefined()
  })

  it('removes a nested server-stitched configuration', () => {
    const out = stripPlayerResponse(
      encode({ playerResponse: { playerConfig: { ssap: { on: true }, audio: {} } } }),
      true
    )
    expect(out.body).not.toBeNull()
    const config = (decode(out.body!)['playerResponse'] as Record<string, unknown>)[
      'playerConfig'
    ] as Record<string, unknown>
    expect(config['ssap']).toBeUndefined()
    expect(config['audio']).toBeDefined()
  })

  it('leaves a response with nothing to remove completely alone', () => {
    // `body: null` means "continue the request untouched" — re-serving an
    // identical body it decoded and re-encoded for no reason is pure cost.
    const out = stripPlayerResponse(encode({ playerResponse: { videoDetails: {} } }), true)
    expect(out.body).toBeNull()
    expect(out.removed).toEqual([])
  })

  it('watches more than the player endpoint', () => {
    // `player` alone was not enough: an in-page navigation asks `next`, and
    // Shorts adverts ride on `reel_watch_sequence`.
    expect(PLAYER_URL_PATTERNS).toContain('*youtubei/v1/player*')
    expect(PLAYER_URL_PATTERNS.some((p) => p.includes('next'))).toBe(true)
    expect(PLAYER_URL_PATTERNS.some((p) => p.includes('reel_watch_sequence'))).toBe(true)
  })
})

describe('pruneAdFields', () => {
  it('stops descending rather than following a pathological body for ever', () => {
    // Bounded because this runs on the browsing path. Twelve levels is well past
    // anything a player response nests to.
    let deep: Record<string, unknown> = { adPlacements: [{ a: 1 }] }
    for (let level = 0; level < 40; level += 1) deep = { child: deep }

    const removed = pruneAdFields(deep)
    expect(removed).toEqual([])
  })

  it('removes every occurrence, not merely the first', () => {
    const body = {
      one: { adPlacements: [{ a: 1 }] },
      two: { nested: { adSlots: [{ b: 2 }] } }
    }
    const removed = pruneAdFields(body)
    expect(removed).toHaveLength(2)
    expect(body.one.adPlacements).toBeUndefined()
    expect(body.two.nested.adSlots).toBeUndefined()
  })

  it('leaves unrelated data untouched', () => {
    const body = { title: 'a video', counts: [1, 2, 3], nested: { keep: true } }
    expect(pruneAdFields(body)).toEqual([])
    expect(body).toEqual({ title: 'a video', counts: [1, 2, 3], nested: { keep: true } })
  })
})
