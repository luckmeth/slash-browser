import { describe, expect, it } from 'vitest'
import { adoptDefaultFeed } from './adoptFeed'
import { SettingsSchema } from '@shared/types/settings'
import { UPDATE_FEED_DEFAULT } from '@shared/types/updates'

const settings = (over: Record<string, unknown> = {}): ReturnType<typeof SettingsSchema.parse> =>
  SettingsSchema.parse({ ...over })

describe('a profile written before the feed had a default', () => {
  it('adopts the feed when the stored value is the old empty default', () => {
    // The measured real-world case: the row holds "" and the build's own
    // default is the GitHub feed, so the browser never checks anything.
    const before = settings({ updateFeedUrl: '', updateFeedAdopted: false })
    const after = adoptDefaultFeed(before)

    expect(after.changed).toBe(true)
    expect(after.settings.updateFeedUrl).toBe(UPDATE_FEED_DEFAULT)
    expect(after.settings.updateFeedAdopted).toBe(true)
  })

  it('leaves a feed the user chose alone, and still marks it adopted', () => {
    const before = settings({ updateFeedUrl: 'https://example.test/f.json', updateFeedAdopted: false })
    const after = adoptDefaultFeed(before)

    expect(after.settings.updateFeedUrl).toBe('https://example.test/f.json')
    expect(after.settings.updateFeedAdopted).toBe(true)
  })

  it('changes nothing else', () => {
    const before = settings({ updateFeedUrl: '', blockAds: false, performanceMode: 'aggressive' })
    const after = adoptDefaultFeed(before)

    expect(after.settings.blockAds).toBe(false)
    expect(after.settings.performanceMode).toBe('aggressive')
  })
})

describe('once it has run', () => {
  // The whole point of the marker: emptying the field is the documented off
  // switch, and a migration that repopulated it would override a privacy
  // choice every launch.
  it('respects an empty feed for ever after', () => {
    const cleared = settings({ updateFeedUrl: '', updateFeedAdopted: true })
    const after = adoptDefaultFeed(cleared)

    expect(after.changed).toBe(false)
    expect(after.settings.updateFeedUrl).toBe('')
  })

  it('does not rewrite the row when there is nothing to do', () => {
    const already = settings({ updateFeedUrl: UPDATE_FEED_DEFAULT, updateFeedAdopted: true })
    expect(adoptDefaultFeed(already).changed).toBe(false)
  })

  it('survives a clear-then-relaunch cycle', () => {
    // Adopt, then the user clears it, then the browser restarts twice.
    let s = adoptDefaultFeed(settings({ updateFeedUrl: '', updateFeedAdopted: false })).settings
    s = { ...s, updateFeedUrl: '' }
    s = adoptDefaultFeed(s).settings
    s = adoptDefaultFeed(s).settings

    expect(s.updateFeedUrl).toBe('')
  })
})

describe('a fresh install', () => {
  it('is marked adopted on first load, so clearing it later sticks', () => {
    const fresh = settings()
    expect(fresh.updateFeedUrl).toBe(UPDATE_FEED_DEFAULT)
    expect(fresh.updateFeedAdopted).toBe(false)

    const after = adoptDefaultFeed(fresh)
    expect(after.settings.updateFeedAdopted).toBe(true)
    expect(after.settings.updateFeedUrl).toBe(UPDATE_FEED_DEFAULT)
  })
})
