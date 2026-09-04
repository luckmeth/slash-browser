import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The order things happen in `AppContext.start()`.
 *
 * A source-shape test, which is unusual here and earns it: this exact mistake
 * shipped, and the symptom was that **the browser did not open**. Two lines
 * were placed at the top of `start()`; one of them reads `pendingCount()`,
 * which queries `coin_intervals`; a query before `db.open()` throws; `start()`
 * aborted; no window was created and no IPC handler was registered. The user
 * saw a taskbar shortcut that did nothing and a session that looked lost.
 *
 * None of typecheck, lint or 1479 unit tests saw it, and none of them could:
 * the ordering is only wrong at runtime, in a method that needs Electron to
 * call. Reading the source is what is left.
 */
const source = (name: string): string =>
  readFileSync(join(__dirname, name), 'utf8')

const startBody = (): string => {
  const text = source('AppContext.ts')
  const begin = text.indexOf('\n  start(): void {')
  expect(begin).toBeGreaterThan(-1)
  // To the next method at the same indentation, which is enough to bound it.
  const after = text.slice(begin + 20)
  const end = after.search(/\n {2}[a-zA-Z]+\(.*\): [a-zA-Z]/)
  return end === -1 ? after : after.slice(0, end)
}

describe('AppContext.start()', () => {
  it('opens the database before anything that queries it', () => {
    const body = startBody()
    const open = body.indexOf('this.db.open()')
    const broadcast = body.indexOf('this.broadcastRewards()')

    expect(open).toBeGreaterThan(-1)
    expect(broadcast).toBeGreaterThan(-1)
    // broadcastRewards -> rewards.status -> pendingCount -> a SELECT.
    expect(open).toBeLessThan(broadcast)
  })

  it('loads settings before restoring the rewards session', () => {
    const body = startBody()
    const load = body.indexOf('this.settings.load()')
    const restore = body.indexOf('this.rewards.restoreSession()')

    expect(load).toBeGreaterThan(-1)
    expect(restore).toBeGreaterThan(-1)
    // restoreSession reaches the baseUrl getter, which reads settings.
    expect(load).toBeLessThan(restore)
  })

  it('returns early for a second call before touching anything', () => {
    const body = startBody()
    const guard = body.indexOf('if (this.started) return')
    const open = body.indexOf('this.db.open()')

    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(open)
  })
})

describe('the launch path', () => {
  it('opens a window even when start() throws', () => {
    // The net added after the above shipped: a browser that starts with one
    // broken subsystem is worth far more than a browser that does not start.
    const text = source('index.ts')
    const guarded = /try\s*\{\s*context\.start\(\)\s*\}\s*catch/.test(text)
    expect(guarded).toBe(true)
  })
})
