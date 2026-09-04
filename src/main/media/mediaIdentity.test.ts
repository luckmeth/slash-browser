import { describe, expect, it } from 'vitest'
import { isSameMedia, mediaIdentity } from './mediaIdentity'
import { MediaLedger, rankCandidates, type SniffedMedia } from './mediaSniffing'

const stream = (url: string, over: Partial<SniffedMedia> = {}): SniffedMedia => ({
  url,
  kind: 'stream',
  media: null,
  label: 'HLS stream',
  size: null,
  contentType: 'application/vnd.apple.mpegurl',
  ...over
})

describe('mediaIdentity — the same media under a new token', () => {
  it('treats a re-signed manifest as the same video', () => {
    // The complaint this exists for: a player refreshes its token every few
    // minutes and the panel grew a row each time.
    expect(
      isSameMedia(
        'https://cdn.test/hls/master.m3u8?token=ABC123&expires=1700000000',
        'https://cdn.test/hls/master.m3u8?token=XYZ789&expires=1700003600'
      )
    ).toBe(true)
  })

  it.each([
    'sig',
    'signature',
    'hmac',
    'expires',
    'st',
    'e',
    'nonce',
    'x-amz-signature',
    'key-pair-id',
    'sid',
    '_',
    'cb'
  ])('ignores the ephemeral parameter %s', (name) => {
    expect(
      isSameMedia(`https://cdn.test/a.m3u8?${name}=one`, `https://cdn.test/a.m3u8?${name}=two`)
    ).toBe(true)
  })

  it('ignores parameter order, which players change between requests', () => {
    expect(
      isSameMedia('https://cdn.test/a.m3u8?id=7&q=1080', 'https://cdn.test/a.m3u8?q=1080&id=7')
    ).toBe(true)
  })

  it('treats a host in different case as one host', () => {
    expect(isSameMedia('https://CDN.Test/a.m3u8', 'https://cdn.test/a.m3u8')).toBe(true)
  })
})

describe('mediaIdentity — genuinely different media', () => {
  it('keeps parameters that name the resource', () => {
    // The failure that would be worse than a duplicate row: picking a row and
    // getting a different film. A parameter nobody recognises is assumed to
    // matter, because assuming otherwise loses information.
    expect(
      isSameMedia('https://cdn.test/play?id=1234', 'https://cdn.test/play?id=5678')
    ).toBe(false)
  })

  it('keeps a quality parameter', () => {
    expect(
      isSameMedia('https://cdn.test/s.m3u8?quality=1080', 'https://cdn.test/s.m3u8?quality=720')
    ).toBe(false)
  })

  it('keeps an unrecognised parameter rather than guessing it away', () => {
    expect(
      isSameMedia('https://cdn.test/s.m3u8?wibble=a', 'https://cdn.test/s.m3u8?wibble=b')
    ).toBe(false)
  })

  it('separates different paths that share a query', () => {
    expect(
      isSameMedia('https://cdn.test/film-a/s.m3u8?token=x', 'https://cdn.test/film-b/s.m3u8?token=y')
    ).toBe(false)
  })

  it('separates different hosts', () => {
    expect(isSameMedia('https://a.test/s.m3u8', 'https://b.test/s.m3u8')).toBe(false)
  })

  it('keeps our own DASH quality fragment, which does name a different track', () => {
    expect(
      isSameMedia('https://cdn.test/m.mpd#rep=v1080', 'https://cdn.test/m.mpd#rep=v720')
    ).toBe(false)
  })

  it('ignores an ordinary fragment, which never reaches a server', () => {
    expect(isSameMedia('https://cdn.test/a.m3u8#t=10', 'https://cdn.test/a.m3u8#t=20')).toBe(true)
  })

  it('returns an unparseable address as its own identity rather than guessing', () => {
    expect(mediaIdentity('not a url')).toBe('not a url')
  })
})

describe('rankCandidates — one row per video', () => {
  it('collapses the same manifest seen under several tokens', () => {
    const ranked = rankCandidates([
      stream('https://cdn.test/master.m3u8?token=A'),
      stream('https://cdn.test/master.m3u8?token=B'),
      stream('https://cdn.test/master.m3u8?token=C')
    ])
    expect(ranked).toHaveLength(1)
  })

  it('keeps the newest address, because the older token may have expired', () => {
    // Downloading from a stale signature is a 403 on a row that looked fine.
    const ranked = rankCandidates([
      stream('https://cdn.test/master.m3u8?token=OLD'),
      stream('https://cdn.test/master.m3u8?token=NEW')
    ])
    expect(ranked[0]?.url).toContain('NEW')
  })

  it('still shows two genuinely different videos as two rows', () => {
    const ranked = rankCandidates([
      stream('https://cdn.test/play?id=1&token=A'),
      stream('https://cdn.test/play?id=2&token=B')
    ])
    expect(ranked).toHaveLength(2)
  })
})

describe('MediaLedger — a player reloading its manifest', () => {
  it('does not report a re-signed manifest as news', () => {
    // Returning `true` here means a re-rank and an IPC broadcast, several times
    // a minute, for a button that is already on screen.
    const ledger = new MediaLedger()
    expect(ledger.record(1, stream('https://cdn.test/m.m3u8?token=A'))).toBe(true)
    expect(ledger.record(1, stream('https://cdn.test/m.m3u8?token=B'))).toBe(false)
    expect(ledger.forTab(1)).toHaveLength(1)
  })

  it('refreshes the stored address to the newest token', () => {
    const ledger = new MediaLedger()
    ledger.record(1, stream('https://cdn.test/m.m3u8?token=OLD'))
    ledger.record(1, stream('https://cdn.test/m.m3u8?token=NEW'))
    expect(ledger.forTab(1)[0]?.url).toContain('NEW')
  })

  it('still records a genuinely new video as news', () => {
    const ledger = new MediaLedger()
    expect(ledger.record(1, stream('https://cdn.test/one.m3u8'))).toBe(true)
    expect(ledger.record(1, stream('https://cdn.test/two.m3u8'))).toBe(true)
    expect(ledger.forTab(1)).toHaveLength(2)
  })

  it('keeps a size that arrives on a later request', () => {
    const ledger = new MediaLedger()
    ledger.record(1, stream('https://cdn.test/f.mp4?token=A', { kind: 'file', size: null }))
    ledger.record(1, stream('https://cdn.test/f.mp4?token=B', { kind: 'file', size: 5_000_000 }))
    expect(ledger.forTab(1)[0]?.size).toBe(5_000_000)
  })

  it('separates the same address across two tabs', () => {
    // Two tabs playing one film are two downloads, and the ledger is per tab.
    const ledger = new MediaLedger()
    ledger.record(1, stream('https://cdn.test/m.m3u8'))
    ledger.record(2, stream('https://cdn.test/m.m3u8'))
    expect(ledger.forTab(1)).toHaveLength(1)
    expect(ledger.forTab(2)).toHaveLength(1)
  })
})
