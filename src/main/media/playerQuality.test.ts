import { describe, expect, it } from 'vitest'
import { playerQualities, READ_QUALITIES_SCRIPT, requestQualityScript } from './playerQuality'

describe('playerQualities', () => {
  it('lists the real qualities best first', () => {
    // The order YouTube returns is not the order anybody wants to read.
    const list = playerQualities(['medium', 'hd1080', 'tiny', 'hd720', 'auto'], 'hd720')
    expect(list.map((q) => q.label)).toEqual(['1080p', '720p', '360p', '144p'])
  })

  it('drops auto, which is a policy rather than a quality', () => {
    // Selecting it would leave the player free to fetch something other than
    // what was asked for, which is the whole problem this exists to solve.
    expect(playerQualities(['auto', 'hd720'], 'auto').map((q) => q.level)).toEqual(['hd720'])
  })

  it('marks the one currently playing', () => {
    const list = playerQualities(['hd1080', 'hd720'], 'hd720')
    expect(list.find((q) => q.current)?.label).toBe('720p')
  })

  it('keeps a tier it does not recognise, and ranks it high', () => {
    // A new tier should appear as an option under its raw name, not vanish.
    const list = playerQualities(['hd4320', 'hd720'], 'hd720')
    expect(list[0]?.level).toBe('hd4320')
    expect(list[0]?.label).toBe('hd4320')
  })

  it('survives an empty list', () => {
    expect(playerQualities([], '')).toEqual([])
  })
})

/**
 * These run the scripts through `new Function` against stand-ins for the page
 * globals. Both are evaluated in the page's own world, where a syntax error or
 * a typo'd property fails no build, no typecheck and no runtime check anybody
 * sees — the feature just quietly reports nothing for ever.
 */
function runScript(source: string, player: unknown): unknown {
  const document = {
    querySelector: (selector: string) => (selector === '#movie_player' ? player : null)
  }
  return new Function('document', `return ${source}`)(document)
}

describe('READ_QUALITIES_SCRIPT', () => {
  it('reads the levels and the current quality', () => {
    const result = runScript(READ_QUALITIES_SCRIPT, {
      getAvailableQualityLevels: () => ['hd1080', 'hd720', 'auto'],
      getPlaybackQuality: () => 'hd720',
      setPlaybackQualityRange: () => {}
    }) as { ok: boolean; levels: string[]; current: string; canSet: boolean }

    expect(result.ok).toBe(true)
    expect(result.levels).toEqual(['hd1080', 'hd720', 'auto'])
    expect(result.current).toBe('hd720')
    expect(result.canSet).toBe(true)
  })

  it('answers in shape when there is no player', () => {
    const result = runScript(READ_QUALITIES_SCRIPT, null) as { ok: boolean; reason: string }
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no player')
  })

  it('answers in shape when the player is half-initialised', () => {
    // A player object exists long before its API does.
    const result = runScript(READ_QUALITIES_SCRIPT, {}) as { ok: boolean }
    expect(result.ok).toBe(false)
  })

  it('does not throw when the player throws', () => {
    const result = runScript(READ_QUALITIES_SCRIPT, {
      getAvailableQualityLevels: () => {
        throw new Error('player exploded')
      }
    }) as { ok: boolean; reason: string }
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('player exploded')
  })
})

describe('requestQualityScript', () => {
  it('asks the player for the level, using the call its own menu makes', () => {
    const calls: string[] = []
    const result = runScript(requestQualityScript('hd1080'), {
      setPlaybackQualityRange: (a: string, b: string) => calls.push(`range:${a}/${b}`),
      setPlaybackQuality: (a: string) => calls.push(`quality:${a}`),
      getPlaybackQuality: () => 'hd1080'
    }) as { ok: boolean; now: string }

    expect(calls).toEqual(['range:hd1080/hd1080', 'quality:hd1080'])
    expect(result.ok).toBe(true)
    expect(result.now).toBe('hd1080')
  })

  it('still works on a player that only has the older call', () => {
    const calls: string[] = []
    runScript(requestQualityScript('hd720'), {
      setPlaybackQuality: (a: string) => calls.push(a),
      getPlaybackQuality: () => 'hd720'
    })
    expect(calls).toEqual(['hd720'])
  })

  it('passes the level as data, not as source', () => {
    // The level crosses an IPC boundary before it comes back here, and this
    // string is evaluated as code in the page. Splicing it in unquoted would be
    // an injection point in the one place hardest to notice.
    //
    // The property under test is not that the characters are absent - quoted,
    // they are still there - but that they reach the player as an inert string
    // and nothing extra executes.
    const seen: string[] = []
    const hostile = "'); (globalThis.__pwned = 1); ('"
    const result = runScript(requestQualityScript(hostile), {
      setPlaybackQualityRange: (a: string) => seen.push(a),
      getPlaybackQuality: () => 'x'
    }) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect(seen).toEqual([hostile])
    expect((globalThis as Record<string, unknown>)['__pwned']).toBeUndefined()
  })

  it('answers in shape when there is no player', () => {
    expect((runScript(requestQualityScript('hd1080'), null) as { ok: boolean }).ok).toBe(false)
  })
})
