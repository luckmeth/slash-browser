import { describe, it, expect } from 'vitest'
import { FilterEngine } from './FilterEngine'
import { DEFAULT_PATH_RULES } from './defaultLists'

function engine(): FilterEngine {
  const filter = new FilterEngine()
  filter.loadPathRules(DEFAULT_PATH_RULES)
  return filter
}

describe('host+path rules', () => {
  it("blocks YouTube's own ad endpoints, which are first-party", () => {
    // The reason these rules exist. Domain matching cannot reach them, because
    // the third-party test that protects ordinary pages exempts them.
    const filter = engine()
    expect(filter.classifyUrl('https://www.youtube.com/ptracking?html5=1&video_id=x')).toBe(
      'tracker'
    )
    expect(filter.classifyUrl('https://www.youtube.com/pagead/interaction/?ai=x')).toBe('ad')
    expect(filter.classifyUrl('https://www.youtube.com/api/stats/ads?ver=2')).toBe('ad')
    expect(filter.classifyUrl('https://www.youtube.com/get_midroll_info?v=x')).toBe('ad')
  })

  it('blocks ad telemetry on hosts that do something else for a living', () => {
    const filter = engine()
    // Verified allowed-through on a real watch page before these rules existed.
    expect(filter.classifyUrl('https://www.google.com/pagead/lvz?evtid=abc')).toBe('ad')
  })

  it('covers every Google country domain, not just .com', () => {
    // A probe against a live page found google.lk/pagead/lvz sailing past a
    // rule written for google.com. There are ~190 of these.
    const filter = engine()
    expect(filter.classifyUrl('https://www.google.lk/pagead/lvz?evtid=abc')).toBe('ad')
    expect(filter.classifyUrl('https://www.google.co.uk/pagead/lvz')).toBe('ad')
    expect(filter.classifyUrl('https://google.de/pagead/lvz')).toBe('ad')
  })

  it('does not break Google Search on any domain', () => {
    // The reason `google.*` is a path rule and not a domain rule.
    const filter = engine()
    expect(filter.classifyUrl('https://www.google.com/search?q=test')).toBeNull()
    expect(filter.classifyUrl('https://www.google.lk/search?q=test')).toBeNull()
    expect(filter.classifyUrl('https://www.google.com/')).toBeNull()
  })

  it('does not let a lookalike claim the Google wildcard', () => {
    const filter = engine()
    expect(filter.classifyUrl('https://notgoogle.com/pagead/lvz')).toBeNull()
    expect(filter.classifyUrl('https://google.com.evil.example/pagead/lvz')).toBeNull()
  })

  it('leaves playback telemetry alone', () => {
    // Blocking watchtime loses resume position; qoe is quality reporting.
    // Neither is advertising, so neither is ours to cancel.
    const filter = engine()
    expect(filter.classifyUrl('https://www.youtube.com/api/stats/watchtime?v=x')).toBeNull()
    expect(filter.classifyUrl('https://www.youtube.com/api/stats/qoe?v=x')).toBeNull()
  })

  it('never touches the video stream itself', () => {
    // YouTube serves ad segments from the same host and path as the content, so
    // a rule here would break playback rather than remove the ad. This is the
    // limit that network filtering cannot cross.
    const filter = engine()
    expect(
      filter.classifyUrl('https://rr1---sn-nau.googlevideo.com/videoplayback?expire=1&ei=2')
    ).toBeNull()
  })

  it('leaves ordinary YouTube pages and its API alone', () => {
    const filter = engine()
    expect(filter.classifyUrl('https://www.youtube.com/watch?v=abc')).toBeNull()
    expect(filter.classifyUrl('https://www.youtube.com/youtubei/v1/player')).toBeNull()
    expect(filter.classifyUrl('https://www.youtube.com/feed/subscriptions')).toBeNull()
  })

  it('matches subdomains but not lookalike hosts', () => {
    const filter = engine()
    expect(filter.classifyUrl('https://m.youtube.com/ptracking')).toBe('tracker')
    expect(filter.classifyUrl('https://youtube.com.evil.example/ptracking')).toBeNull()
  })

  it('ignores a URL it cannot parse', () => {
    expect(engine().classifyUrl('not a url')).toBeNull()
    expect(engine().classifyUrl('')).toBeNull()
  })

  it('is case-insensitive on the path', () => {
    expect(engine().classifyUrl('https://www.youtube.com/PageAd/id')).toBe('ad')
  })
})
