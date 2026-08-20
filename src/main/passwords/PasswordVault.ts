import { safeStorage } from 'electron'
import type { SavedLogin, VaultStatus } from '@shared/types/logins'
import type { Database } from '../db/Database'
import { createLogger } from '../logger'

const log = createLogger('vault')

interface Row {
  id: number
  host: string
  username: string
  password_enc: Buffer
  created_at: number
  updated_at: number
  last_used_at: number | null
}

/**
 * Saved sign-ins, encrypted by the operating system's own credential store.
 *
 * Three rules, each of which is load-bearing:
 *
 *  1. **No plaintext, ever, anywhere.** The password exists decrypted only
 *     inside `passwordFor`'s return value, for as long as the caller holds it.
 *     The schema has no column that could hold a readable password, so there is
 *     no state in which one is written by mistake.
 *  2. **No secure store, no saving.** If `safeStorage` is unavailable this
 *     refuses rather than falling back to something readable next to the
 *     browsing history. A password manager that quietly degrades to a text file
 *     is worse than no password manager, because the user believes they have
 *     one.
 *  3. **Nothing decrypted crosses IPC.** `passwordFor` is main-process only and
 *     is called by the filling path, which hands the value to Chromium's input
 *     pipeline. No IPC reply carries a password, which is enforced by
 *     `SavedLogin` having no field to put one in.
 */
export class PasswordVault {
  constructor(private readonly db: Database) {}

  get available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  status(): VaultStatus {
    const logins = this.list()
    return { available: this.available, count: logins.length, logins }
  }

  /** Metadata only. There is no overload of this that returns passwords. */
  list(): SavedLogin[] {
    return this.db.connection
      .prepare<[], Row>(
        `SELECT id, host, username, password_enc, created_at, updated_at, last_used_at
           FROM saved_logins ORDER BY host, username`
      )
      .all()
      .map(toLogin)
  }

  forHost(host: string): SavedLogin[] {
    return this.db.connection
      .prepare<[string], Row>(
        `SELECT id, host, username, password_enc, created_at, updated_at, last_used_at
           FROM saved_logins WHERE host = ? ORDER BY username`
      )
      .all(normaliseHost(host))
      .map(toLogin)
  }

  /**
   * Saves or updates one sign-in.
   *
   * @returns why it failed, or null on success. A boolean would not carry the
   *   distinction the interface has to explain — "this machine has no secure
   *   store" and "that is not a site" need different words.
   */
  save(input: { host: string; username: string; password: string }): string | null {
    const host = normaliseHost(input.host)
    if (host === '') return 'That does not look like a site.'
    if (input.password === '') return 'A password is needed.'
    if (!this.available) {
      return 'This system has no secure credential store, so Slash will not save the password. Keeping it in readable form beside your browsing history is not something it will do.'
    }

    const encrypted = safeStorage.encryptString(input.password)
    const now = Date.now()
    this.db.connection
      .prepare(
        `INSERT INTO saved_logins (host, username, password_enc, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(host, username) DO UPDATE SET
           password_enc = excluded.password_enc,
           updated_at = excluded.updated_at`
      )
      .run(host, input.username, encrypted, now, now)
    log.info(`saved a sign-in for ${host}`)
    return null
  }

  /**
   * The decrypted password for one entry.
   *
   * **Main process only.** Every caller must hand the value straight to
   * Chromium's input pipeline and hold no copy — see `LoginFiller`.
   */
  passwordFor(id: number): string | null {
    const row = this.db.connection
      .prepare<[number], Row>('SELECT * FROM saved_logins WHERE id = ?')
      .get(id)
    if (!row) return null
    if (!this.available) return null

    try {
      return safeStorage.decryptString(row.password_enc)
    } catch (error) {
      // A blob that will not decrypt is one encrypted under a different user
      // account or a reset key. Reported rather than thrown: the correct outcome
      // is "cannot fill, please retype", not a crash.
      log.warn(`could not decrypt the sign-in for ${row.host}`, error)
      return null
    }
  }

  markUsed(id: number): void {
    this.db.connection
      .prepare('UPDATE saved_logins SET last_used_at = ? WHERE id = ?')
      .run(Date.now(), id)
  }

  remove(id: number): void {
    this.db.connection.prepare('DELETE FROM saved_logins WHERE id = ?').run(id)
  }

  clearAll(): void {
    this.db.connection.prepare('DELETE FROM saved_logins').run()
  }
}

/**
 * Host, lower-cased and without `www.`.
 *
 * Sites move between the bare domain and the www subdomain freely, and a user
 * does not think of those as two accounts.
 */
export function normaliseHost(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') return ''
  try {
    // Accepts either a bare host or a full URL, so callers do not each have to
    // remember which they are holding.
    const host = trimmed.includes('://') ? new URL(trimmed).hostname : trimmed
    return host.replace(/^www\./, '')
  } catch {
    return trimmed.replace(/^www\./, '')
  }
}

function toLogin(row: Row): SavedLogin {
  // Note what is *not* copied across: password_enc stops here.
  return {
    id: row.id,
    host: row.host,
    username: row.username,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at
  }
}
