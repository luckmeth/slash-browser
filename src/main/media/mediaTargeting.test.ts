import { describe, it, expect } from 'vitest'
import { chooseMediaTarget, nowPlaying, type MediaCandidate } from './mediaTargeting'

const tab = (over: Partial<MediaCandidate> & { id: string }): MediaCandidate => ({
  isAudible: false,
  isMuted: false,
  lastAudibleAt: 0,
  isActive: false,
  ...over
})

describe('chooseMediaTarget', () => {
  it('picks what is actually making sound over what is in front', () => {
    // Pause must stop what you can hear. Stopping the tab you happen to be
    // looking at while the noise carries on is the failure that makes media
    // keys feel broken.
    const target = chooseMediaTarget([
      tab({ id: 'looking-at', isActive: true, lastAudibleAt: 10 }),
      tab({ id: 'playing', isAudible: true, lastAudibleAt: 5 })
    ])
    expect(target).toBe('playing')
  })

  it('prefers the most recent of several audible tabs', () => {
    const target = chooseMediaTarget([
      tab({ id: 'old', isAudible: true, lastAudibleAt: 100 }),
      tab({ id: 'new', isAudible: true, lastAudibleAt: 200 })
    ])
    expect(target).toBe('new')
  })

  it('ignores a muted tab when deciding what is audible', () => {
    // A muted tab cannot be what the user is hearing, so it cannot be what they
    // meant to pause.
    const target = chooseMediaTarget([
      tab({ id: 'muted', isAudible: true, isMuted: true, lastAudibleAt: 200 }),
      tab({ id: 'heard', isAudible: true, lastAudibleAt: 100 })
    ])
    expect(target).toBe('heard')
  })

  it('falls back to the tab in front when nothing is playing', () => {
    // Someone watching a paused video expects play to resume this one.
    const target = chooseMediaTarget([
      tab({ id: 'front', isActive: true, lastAudibleAt: 50 }),
      tab({ id: 'other', lastAudibleAt: 500 })
    ])
    expect(target).toBe('front')
  })

  it('will resume a muted tab in front, because play should still work', () => {
    const target = chooseMediaTarget([tab({ id: 'front', isActive: true, isMuted: true, lastAudibleAt: 5 })])
    expect(target).toBe('front')
  })

  it('ignores a front tab that has never played anything', () => {
    // Otherwise a media key aimed at background music would be swallowed by
    // whatever article happened to be open.
    const target = chooseMediaTarget([
      tab({ id: 'article', isActive: true, lastAudibleAt: 0 }),
      tab({ id: 'music', lastAudibleAt: 400 })
    ])
    expect(target).toBe('music')
  })

  it('resumes the most recently played tab when nothing else applies', () => {
    const target = chooseMediaTarget([
      tab({ id: 'a', lastAudibleAt: 100 }),
      tab({ id: 'b', lastAudibleAt: 300 })
    ])
    expect(target).toBe('b')
  })

  it('returns null when nothing has ever played', () => {
    expect(chooseMediaTarget([tab({ id: 'a' }), tab({ id: 'b' })])).toBeNull()
    expect(chooseMediaTarget([])).toBeNull()
  })
})

describe('nowPlaying', () => {
  it('lists audible tabs, newest first', () => {
    const rows = nowPlaying([
      tab({ id: 'old', isAudible: true, lastAudibleAt: 1 }),
      tab({ id: 'new', isAudible: true, lastAudibleAt: 9 })
    ])
    expect(rows.map((row) => row.id)).toEqual(['new', 'old'])
  })

  it('keeps a muted tab that has played, so it can be unmuted from here', () => {
    // Hiding it is how somebody ends up hunting through tabs for the one they
    // silenced.
    const rows = nowPlaying([tab({ id: 'muted', isMuted: true, lastAudibleAt: 5 })])
    expect(rows.map((row) => row.id)).toEqual(['muted'])
  })

  it('leaves out tabs that have never made a sound', () => {
    expect(nowPlaying([tab({ id: 'quiet' })])).toEqual([])
  })
})
