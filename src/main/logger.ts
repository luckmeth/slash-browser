import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const threshold: number = LEVEL_ORDER[
  (process.env['ADAPTIVE_LOG_LEVEL'] as Level | undefined) ??
    (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug')
]

/**
 * Where the log goes, and why there is a file at all.
 *
 * A packaged Electron application on Windows is not attached to a console, so
 * everything written here went nowhere the moment the browser was installed.
 * That is not a small gap: when a request to the rewards service failed with a
 * 400, the reason had already been logged in full and there was no way to read
 * it — the only way to find out was to reproduce the call by hand against the
 * live database. Slash Operations learned this first and writes
 * `operations.log`; this is the same fix for the browser.
 *
 * Resolved lazily rather than at import: this module is loaded before
 * `app.setPath('userData')` has chosen a profile, and asking for a path before
 * then would pin the log — and only the log — to the wrong profile.
 */
let logPath: string | null = null
let resolving = false

/** 2 MB, then one rotation. A log nobody can open is as useless as no log. */
const MAX_LOG_BYTES = 2 * 1024 * 1024

function fileSink(): string | null {
  if (logPath !== null) return logPath
  if (resolving) return null
  resolving = true

  try {
    // Imported here, not at module scope: this file is used by tests that must
    // not pull Electron in, which is the rule for everything under main.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } }
    const app = electron.app
    if (!app?.getPath) return null
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'slash.log')
    return logPath
  } catch {
    // No Electron, or no writable path. Console-only is the fallback, which is
    // exactly what a development run wants anyway.
    return null
  } finally {
    resolving = false
  }
}

function writeLine(line: string): void {
  const path = fileSink()
  if (path === null) return
  try {
    // Rotated by size before appending, so one long-running window cannot fill
    // a disk. One generation is kept: the question a log answers here is
    // always "what happened just now".
    try {
      if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`)
    } catch {
      /* no file yet, or a rename that lost a race; either is fine */
    }
    appendFileSync(path, `${line}\n`)
  } catch {
    /* logging must never be the thing that breaks the browser */
  }
}

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < threshold) return
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope}: ${message}`
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (extra === undefined) sink(line)
  else sink(line, extra)

  // Warnings and errors only. Everything at info and below is noise that would
  // rotate away the one line somebody is looking for.
  if (LEVEL_ORDER[level] >= LEVEL_ORDER.warn) {
    writeLine(extra === undefined ? line : `${line} ${safely(extra)}`)
  }
}

/** Whatever `extra` is, as text, without throwing on a circular object. */
function safely(value: unknown): string {
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Scoped logger for the main process.
 *
 * Errors are logged here in full but never returned across IPC — the renderer
 * receives an `AppError` with a safe message instead, so stack traces and
 * filesystem paths cannot leak into a view that also hosts web content.
 */
export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e)
  }
}

export type Logger = ReturnType<typeof createLogger>
