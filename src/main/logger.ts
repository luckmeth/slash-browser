type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const threshold: number = LEVEL_ORDER[
  (process.env['ADAPTIVE_LOG_LEVEL'] as Level | undefined) ??
    (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug')
]

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < threshold) return
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope}: ${message}`
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (extra === undefined) sink(line)
  else sink(line, extra)
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
