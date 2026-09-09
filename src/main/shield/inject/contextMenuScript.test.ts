import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { buildContextMenuScript } from './contextMenuScript'

/**
 * The right-click restorer is a **string of JavaScript** evaluated in a page's
 * own world. A syntax error or a typo'd property fails no build, no typecheck
 * and no lint — the feature simply never works, on every site, for ever.
 *
 * CLAUDE.md has asked for this since `EXTRACT_SCRIPT` shipped the same failure
 * twice. What a unit test can reach is what the script *does* once it runs;
 * whether it arrived is a separate question, answered by
 * `SLASH_CONTEXTMENU_PROBE` against a real page.
 */
interface Listener {
  readonly type: string
  readonly handler: (event: unknown) => void
  readonly capture: unknown
}

interface Harness {
  window: Record<string, unknown>
  listeners: Listener[]
  intervals: { handler: () => void; cleared: boolean }[]
  threw: Error | null
}

function run(): Harness {
  const listeners: Listener[] = []
  const intervals: { handler: () => void; cleared: boolean }[] = []

  const node = (): Record<string, unknown> => ({
    oncontextmenu: null,
    addEventListener: (type: string, handler: (event: unknown) => void, capture: unknown) => {
      listeners.push({ type, handler, capture })
    }
  })

  const document = node()
  document['body'] = node()
  document['documentElement'] = node()

  const sandbox: Record<string, unknown> = {
    document,
    setInterval: (handler: () => void) => {
      intervals.push({ handler, cleared: false })
      return intervals.length - 1
    },
    clearInterval: (id: number) => {
      const entry = intervals[id]
      if (entry) entry.cleared = true
    },
    addEventListener: (type: string, handler: (event: unknown) => void, capture: unknown) => {
      listeners.push({ type, handler, capture })
    }
  }
  sandbox['window'] = sandbox
  sandbox['globalThis'] = sandbox

  let threw: Error | null = null
  try {
    vm.runInContext(buildContextMenuScript(), vm.createContext(sandbox))
  } catch (error) {
    threw = error as Error
  }
  return { window: sandbox, listeners, intervals, threw }
}

describe('buildContextMenuScript', () => {
  it('parses as JavaScript', () => {
    expect(() => new Function(buildContextMenuScript())).not.toThrow()
  })

  it('carries no control bytes', () => {
    // A backspace written by a shell heredoc is invisible in an editor and in a
    // diff, and silently turns a working script into a broken one. CLAUDE.md
    // records this happening to the sign-in guard.
    const control = [...buildContextMenuScript()].filter((character) => {
      const code = character.charCodeAt(0)
      return code < 9 || (code > 13 && code < 32)
    })
    expect(control).toEqual([])
  })

  it('runs without throwing', () => {
    expect(run().threw).toBeNull()
  })

  it('listens on the capture phase, which is the whole mechanism', () => {
    // Capture is not a detail here. A bubble-phase listener runs *after* the
    // site's handler has already cancelled the event, and `preventDefault`
    // cannot be undone once called.
    const contextmenu = run().listeners.filter((entry) => entry.type === 'contextmenu')
    expect(contextmenu.length).toBeGreaterThanOrEqual(2)
    for (const entry of contextmenu) expect(entry.capture).toBe(true)
  })

  it('stops the page ever seeing the event', () => {
    const handler = run().listeners.find((entry) => entry.type === 'contextmenu')?.handler
    let stopped = 0
    let prevented = 0
    handler?.({
      stopImmediatePropagation: () => {
        stopped += 1
      },
      preventDefault: () => {
        prevented += 1
      }
    })
    expect(stopped).toBe(1)
    // It must **not** preventDefault — that would suppress the browser's own
    // menu, which is the thing being restored.
    expect(prevented).toBe(0)
  })

  it('clears inline oncontextmenu handlers, which propagation cannot reach', () => {
    const harness = run()
    const document = harness.window['document'] as Record<string, unknown>
    expect(document['oncontextmenu']).toBeNull()
    expect((document['body'] as Record<string, unknown>)['oncontextmenu']).toBeNull()
    expect((document['documentElement'] as Record<string, unknown>)['oncontextmenu']).toBeNull()
  })

  it('re-clears handlers a site re-applies after load', () => {
    const harness = run()
    const document = harness.window['document'] as Record<string, unknown>
    document['oncontextmenu'] = () => undefined

    harness.intervals[0]?.handler()
    expect(document['oncontextmenu']).toBeNull()
  })

  it('stops polling rather than running for the life of the page', () => {
    // A timer that never stops is a cost paid on every page for a convenience.
    const harness = run()
    const timer = harness.intervals[0]
    expect(timer).toBeDefined()
    for (let tick = 0; tick < 20; tick += 1) timer?.handler()
    expect(timer?.cleared).toBe(true)
  })
})
