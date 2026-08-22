import { describe, it, expect } from 'vitest'
import { interpretConfig } from './interpretConfig'

describe('interpretConfig', () => {
  it('reads a well-formed set', () => {
    const config = interpretConfig({
      show_advertise_cta: false,
      notice: { message: 'Maintenance on Sunday', level: 'warn', url: 'https://example.com/status' },
      feature_flags: { newThing: true, oldThing: false }
    })
    expect(config.showAdvertiseCta).toBe(false)
    expect(config.notice.message).toBe('Maintenance on Sunday')
    expect(config.notice.level).toBe('warn')
    expect(config.flags).toEqual({ newThing: true, oldThing: false })
  })

  it('falls back to defaults for an empty set', () => {
    const config = interpretConfig({})
    expect(config.showAdvertiseCta).toBe(true)
    expect(config.notice.message).toBe('')
    expect(config.flags).toEqual({})
  })

  it('lets one bad value spoil only itself', () => {
    // The far end is a table an operator edits by hand. A typo must change one
    // thing at most, not take the start page down.
    const config = interpretConfig({
      show_advertise_cta: 'yes please',
      notice: 'not an object',
      feature_flags: { good: true, bad: 'true' }
    })
    expect(config.showAdvertiseCta).toBe(true)
    expect(config.notice.message).toBe('')
    expect(config.flags).toEqual({ good: true })
  })

  it('refuses a notice link that is not https', () => {
    // This is a link the publisher can put in front of every user of the
    // browser, which is not a thing to send over plain http.
    expect(interpretConfig({ notice: { message: 'hi', url: 'http://example.com' } }).notice.url).toBe('')
    expect(interpretConfig({ notice: { message: 'hi', url: 'javascript:alert(1)' } }).notice.url).toBe('')
    expect(
      interpretConfig({ notice: { message: 'hi', url: 'https://example.com' } }).notice.url
    ).toBe('https://example.com')
  })

  it('caps a very long notice', () => {
    expect(interpretConfig({ notice: { message: 'x'.repeat(5000) } }).notice.message.length).toBe(300)
  })

  it('falls back to info for an unknown level', () => {
    expect(interpretConfig({ notice: { message: 'hi', level: 'catastrophe' } }).notice.level).toBe('info')
  })

  it('treats a null notice as no notice', () => {
    expect(interpretConfig({ notice: null }).notice.message).toBe('')
  })
})
