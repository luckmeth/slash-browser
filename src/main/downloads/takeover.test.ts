import { describe, it, expect } from 'vitest'
import {
  MIN_TAKEOVER_BYTES,
  shouldTakeOver,
  speedClaim,
  type TakeoverRequest
} from './takeover'

const request = (over: Partial<TakeoverRequest> = {}): TakeoverRequest => ({
  url: 'https://cdn.example.com/installer.zip',
  totalBytes: 200 * 1024 * 1024,
  enabled: true,
  askWhereToSave: false,
  ...over
})

describe('shouldTakeOver', () => {
  it('takes a big file over http', () => {
    expect(shouldTakeOver(request())).toEqual({ take: true })
  })

  it('leaves everything alone when the setting is off', () => {
    expect(shouldTakeOver(request({ enabled: false })).take).toBe(false)
  })

  it('leaves it alone when the user wants the save dialog', () => {
    // Accelerating at the cost of silently ignoring a preference is not a trade
    // to make on somebody's behalf.
    expect(shouldTakeOver(request({ askWhereToSave: true })).take).toBe(false)
  })

  it('refuses a URL that cannot be requested again', () => {
    // blob: and data: exist only inside the page that made them.
    expect(shouldTakeOver(request({ url: 'blob:https://x.com/abc' })).take).toBe(false)
    expect(shouldTakeOver(request({ url: 'data:text/plain,hello' })).take).toBe(false)
    expect(shouldTakeOver(request({ url: 'ftp://example.com/f.zip' })).take).toBe(false)
  })

  it('refuses when the length is unknown', () => {
    // The engine cannot plan segments, so it would open one connection — what
    // Chromium is already doing, at the price of an extra request.
    expect(shouldTakeOver(request({ totalBytes: 0 })).take).toBe(false)
    expect(shouldTakeOver(request({ totalBytes: -1 })).take).toBe(false)
  })

  it('leaves small downloads to Chromium', () => {
    // Under the threshold the extra round trip costs more than splitting saves,
    // and a small download is exactly the shape of a form result — which asking
    // again as a GET would break, or worse, repeat.
    expect(shouldTakeOver(request({ totalBytes: 40 * 1024 })).take).toBe(false)
    expect(shouldTakeOver(request({ totalBytes: MIN_TAKEOVER_BYTES - 1 })).take).toBe(false)
  })

  it('takes over at exactly the threshold', () => {
    expect(shouldTakeOver(request({ totalBytes: MIN_TAKEOVER_BYTES })).take).toBe(true)
  })

  it('gives a reason every time it declines', () => {
    // The reason is logged. A takeover that silently did not happen is
    // indistinguishable from one that was never wired up.
    for (const over of [
      { enabled: false },
      { askWhereToSave: true },
      { url: 'blob:x' },
      { totalBytes: 0 },
      { totalBytes: 1000 }
    ]) {
      const verdict = shouldTakeOver(request(over))
      expect(verdict.take).toBe(false)
      if (!verdict.take) expect(verdict.because.length).toBeGreaterThan(10)
    }
  })
})

describe('speedClaim', () => {
  it('claims a multiple, never a time', () => {
    // A browser that promises "14 seconds" and takes ninety has told a small lie
    // people remember.
    expect(speedClaim(4, true)).toBe('up to 4× faster')
  })

  it('claims nothing when the server will not serve ranges', () => {
    expect(speedClaim(4, false)).toBeNull()
  })

  it('claims nothing on a single connection', () => {
    expect(speedClaim(1, true)).toBeNull()
  })
})
