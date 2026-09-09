import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { buildPopupDefuserScript } from './popupDefuserScript'

/**
 * The pop-up defuser is a **string of JavaScript** evaluated in a page's own
 * world, and its whole value is that it changes exactly one thing: the value
 * `window.open` hands back when the browser refused. Everything else — the
 * shield's verdict, the gesture accounting, the held-popup notice — must be
 * untouched, and a test is the only thing that can hold that line as the script
 * is edited.
 */
interface Harness {
  window: Record<string, unknown>
  calls: unknown[][]
  threw: Error | null
}

function run(options: {
  protocol?: string
  opens?: (...args: unknown[]) => unknown
}): Harness {
  const calls: unknown[][] = []
  const sandbox: Record<string, unknown> = {
    location: { protocol: options.protocol ?? 'https:' },
    open:
      options.opens === undefined
        ? (...args: unknown[]) => {
            calls.push(args)
            return null
          }
        : (...args: unknown[]) => {
            calls.push(args)
            return options.opens?.(...args)
          }
  }
  sandbox['window'] = sandbox
  sandbox['globalThis'] = sandbox

  let threw: Error | null = null
  try {
    vm.runInContext(buildPopupDefuserScript(), vm.createContext(sandbox))
  } catch (error) {
    threw = error as Error
  }
  return { window: sandbox, calls, threw }
}

describe('buildPopupDefuserScript', () => {
  it('parses as JavaScript', () => {
    expect(() => new Function(buildPopupDefuserScript())).not.toThrow()
  })

  it('carries no control bytes', () => {
    const control = [...buildPopupDefuserScript()].filter((character) => {
      const code = character.charCodeAt(0)
      return code < 9 || (code > 13 && code < 32)
    })
    expect(control).toEqual([])
  })

  it('still calls the real window.open, so it decides nothing', () => {
    // The most important assertion in this file. If the real `open` stopped
    // being called, the shield's verdict and the held-popup notice would both
    // silently stop happening while the page carried on working.
    const harness = run({})
    ;(harness.window['open'] as (url: string) => unknown)('https://example.com/')
    expect(harness.calls).toEqual([['https://example.com/']])
  })

  it('passes every argument through untouched', () => {
    const harness = run({})
    ;(harness.window['open'] as (...args: unknown[]) => unknown)(
      'https://example.com/',
      '_blank',
      'width=400'
    )
    expect(harness.calls[0]).toEqual(['https://example.com/', '_blank', 'width=400'])
  })

  it('returns the real window when one was genuinely opened', () => {
    const real = { marker: 'the real thing' }
    const harness = run({ opens: () => real })
    const returned = (harness.window['open'] as (url: string) => unknown)('https://example.com/')
    expect(returned).toBe(real)
  })

  it('returns a stand-in instead of null, so the calling code survives', () => {
    const harness = run({})
    const returned = (harness.window['open'] as (url: string) => unknown)(
      'https://example.com/'
    ) as Record<string, unknown>

    expect(returned).not.toBeNull()
    // The exact shape sloppy popunder code touches: `w.blur(); window.focus();`
    expect(() => (returned['blur'] as () => void)()).not.toThrow()
    expect(() => (returned['focus'] as () => void)()).not.toThrow()
    expect(() => (returned['close'] as () => void)()).not.toThrow()
    expect(() => (returned['postMessage'] as () => void)()).not.toThrow()
  })

  it('reports the stand-in as open, because "closed" is an anti-adblock probe', () => {
    const harness = run({})
    const returned = (harness.window['open'] as (url: string) => unknown)(
      'https://example.com/'
    ) as Record<string, unknown>
    expect(returned['closed']).toBe(false)
  })

  it('gives the stand-in self-references, which window-like code walks', () => {
    const harness = run({})
    const returned = (harness.window['open'] as (url: string) => unknown)(
      'https://example.com/'
    ) as Record<string, unknown>
    expect(returned['self']).toBe(returned)
    expect(returned['window']).toBe(returned)
  })

  it('returns a stand-in when Chromium refuses by throwing', () => {
    const harness = run({
      opens: () => {
        throw new Error('blocked')
      }
    })
    let returned: unknown
    expect(() => {
      returned = (harness.window['open'] as (url: string) => unknown)('https://example.com/')
    }).not.toThrow()
    expect(returned).toBeTruthy()
  })

  it('still looks native, because pages check', () => {
    const harness = run({})
    expect(String(harness.window['open'])).toBe('function open() { [native code] }')
  })

  it.each(['about:', 'file:', 'chrome:', 'data:'])('does nothing on %s pages', (protocol) => {
    const harness = run({ protocol })
    const open = harness.window['open'] as (url: string) => unknown
    // Untouched: the original returns null, and no stand-in replaces it.
    expect(open('https://example.com/')).toBeNull()
  })

  it('does nothing when there is no window.open to wrap', () => {
    const sandbox: Record<string, unknown> = { location: { protocol: 'https:' }, open: undefined }
    sandbox['window'] = sandbox
    sandbox['globalThis'] = sandbox
    expect(() =>
      vm.runInContext(buildPopupDefuserScript(), vm.createContext(sandbox))
    ).not.toThrow()
    expect(sandbox['open']).toBeUndefined()
  })
})
