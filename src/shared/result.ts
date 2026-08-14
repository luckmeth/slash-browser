/**
 * A structured-clone-safe Result type.
 *
 * Nothing throws across the IPC boundary. Electron serialises rejected promises
 * into opaque `Error: Error invoking remote method` strings that discard the
 * original type, message and stack — so every handler returns one of these
 * instead, and the renderer branches on `ok` rather than using try/catch.
 */

export type AppErrorCode =
  /** Payload failed its zod contract. */
  | 'VALIDATION'
  /** Sender was not an allowlisted frame. */
  | 'FORBIDDEN'
  /** Referenced entity does not exist (tab, workspace, snapshot...). */
  | 'NOT_FOUND'
  /** Electron/Chromium genuinely cannot do this. Surface the reason to the user. */
  | 'UNSUPPORTED'
  /** Unexpected failure. Details are logged in main, not sent to the renderer. */
  | 'INTERNAL'

export interface AppError {
  readonly code: AppErrorCode
  readonly message: string
  /** Safe-to-display extra context. Never put stack traces or paths here. */
  readonly detail?: string
}

export type Ok<T> = { readonly ok: true; readonly value: T }
export type Err<E = AppError> = { readonly ok: false; readonly error: E }
export type Result<T, E = AppError> = Ok<T> | Err<E>

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

export function err(code: AppErrorCode, message: string, detail?: string): Err<AppError> {
  return { ok: false, error: detail === undefined ? { code, message } : { code, message, detail } }
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok
}

/** Unwrap in tests and call sites that have already checked, or throw loudly. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value
  throw new Error(`unwrap() on Err: ${JSON.stringify(r.error)}`)
}
