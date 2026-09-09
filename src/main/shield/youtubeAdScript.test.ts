import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { buildYouTubeAdScript } from './youtubeAdScript'

/**
 * The YouTube strip is a **string of JavaScript** evaluated in a page's own
 * world, so a syntax error or a typo'd property fails no build, no typecheck and
 * no lint. CLAUDE.md records the same lesson about `EXTRACT_SCRIPT`, and this
 * one had gone untested for longer.
 *
 * What this can and cannot show is worth being clear about. It proves the script
 * *does the right thing when it runs* — the honest limit is that it cannot prove
 * the script reaches a real page, and the bug that actually reached users was
 * precisely that: `Page.enable` had been removed as an optimisation, so
 * `addScriptToEvaluateOnNewDocument` resolved successfully and the script never
 * ran. `SLASH_YT_TIMING_PROBE` is what covers delivery, by asking the page
 * whether the script's own stylesheet is there.
 */
function runOn(hostname: string, response: Record<string, unknown> | undefined): {
  window: Record<string, unknown>
  threw: Error | null
} {
  const sandbox: Record<string, unknown> = {
    location: { hostname },
    document: {
      addEventListener: () => undefined,
      getElementById: () => null,
      createElement: () => ({ set textContent(_value: string) {}, id: '' }),
      head: { appendChild: () => undefined },
      documentElement: { appendChild: () => undefined },
      querySelectorAll: () => []
    },
    MutationObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
    JSON,
    Object,
    Response: class {},
    XMLHttpRequest: class {},
    fetch: () => undefined,
    setTimeout
  }
  sandbox['window'] = sandbox
  sandbox['globalThis'] = sandbox
  if (response !== undefined) sandbox['ytInitialPlayerResponse'] = response

  let threw: Error | null = null
  try {
    vm.runInContext(buildYouTubeAdScript(), vm.createContext(sandbox))
  } catch (error) {
    threw = error as Error
  }
  return { window: sandbox, threw }
}

const AD_FIELDS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'] as const

function watchPageResponse(): Record<string, unknown> {
  return {
    videoDetails: { videoId: 'x' },
    streamingData: {},
    adPlacements: [{ a: 1 }],
    playerAds: [{ b: 2 }],
    adSlots: [{ c: 3 }],
    adBreakHeartbeatParams: 'zzz',
    playerConfig: { ssap: { on: true }, audioConfig: {} }
  }
}

describe('buildYouTubeAdScript', () => {
  it('parses as JavaScript', () => {
    expect(() => new Function(buildYouTubeAdScript())).not.toThrow()
  })

  it('carries no control bytes', () => {
    // A backspace written by a shell heredoc is invisible in an editor and in a
    // diff, and turns a regex into one that matches nothing. CLAUDE.md records
    // this happening to the sign-in guard; it is checked rather than trusted.
    const control = [...buildYouTubeAdScript()].filter((character) => {
      const code = character.charCodeAt(0)
      return code < 9 || (code > 13 && code < 32)
    })
    expect(control).toEqual([])
  })

  it('strips every ad field from a response already on the page', () => {
    const { window, threw } = runOn('www.youtube.com', watchPageResponse())
    expect(threw).toBeNull()
    const response = window['ytInitialPlayerResponse'] as Record<string, unknown>
    for (const field of AD_FIELDS) expect(response[field]).toBeUndefined()
  })

  it('removes the server-stitched configuration, which is not a top-level field', () => {
    const { window } = runOn('www.youtube.com', watchPageResponse())
    const response = window['ytInitialPlayerResponse'] as { playerConfig: Record<string, unknown> }
    expect(response.playerConfig.ssap).toBeUndefined()
    // Only `ssap` — removing playerConfig wholesale would break playback.
    expect(response.playerConfig['audioConfig']).toBeDefined()
  })

  it('installs an accessor, so a response assigned later is stripped too', () => {
    const { window } = runOn('www.youtube.com', undefined)
    const descriptor = Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse')
    expect(typeof descriptor?.get).toBe('function')

    window['ytInitialPlayerResponse'] = watchPageResponse()
    const response = window['ytInitialPlayerResponse'] as Record<string, unknown>
    for (const field of AD_FIELDS) expect(response[field]).toBeUndefined()
    // The response itself must survive: swallowing it breaks playback outright.
    expect(response['videoDetails']).toBeDefined()
  })

  it('leaves objects that are not player responses alone', () => {
    const { window } = runOn('www.youtube.com', undefined)
    const unrelated = { adPlacements: 'not a player response', keep: true }
    window['ytInitialPlayerResponse'] = unrelated
    // `adPlacements` alone marks it as a player response, so this one *is*
    // touched — the guard is about shape, and this asserts the shape it uses
    // rather than a hope about intent.
    expect((window['ytInitialPlayerResponse'] as Record<string, unknown>)['keep']).toBe(true)
  })

  it.each(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'])(
    'runs on %s',
    (hostname) => {
      const { window } = runOn(hostname, watchPageResponse())
      const response = window['ytInitialPlayerResponse'] as Record<string, unknown>
      expect(response['adPlacements']).toBeUndefined()
    }
  )

  it.each(['example.com', 'notyoutube.com', 'youtube.com.evil.test'])(
    'does nothing on %s',
    (hostname) => {
      const { window } = runOn(hostname, watchPageResponse())
      const response = window['ytInitialPlayerResponse'] as Record<string, unknown>
      // Untouched, including the lookalike host — the gate is an anchored
      // suffix match, not a substring one.
      for (const field of AD_FIELDS) expect(response[field]).toBeDefined()
    }
  )
})
