import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../logger'
import { migrations, LATEST_SCHEMA_VERSION } from './migrations'

type SqliteDatabase = BetterSqlite3.Database

const log = createLogger('db')

export interface DatabaseStatus {
  path: string
  sqliteVersion: string
  schemaVersion: number
  walEnabled: boolean
  foreignKeysEnabled: boolean
}

/**
 * Owns the single SQLite connection for a profile.
 *
 * better-sqlite3 is synchronous. That is a deliberate fit for the main process:
 * queries here are small and indexed, and synchronous calls avoid the ordering
 * bugs an async driver invites when several IPC handlers mutate the same rows.
 * Anything that could genuinely block — full-text indexing, embedding — belongs
 * in a utility process (Phase 5), not on this connection.
 */
export class Database {
  private db: SqliteDatabase | null = null
  private readonly file: string

  constructor(userDataDir: string, fileName = 'adaptive-browser.db') {
    this.file = join(userDataDir, fileName)
  }

  open(): void {
    if (this.db) return

    this.db = new BetterSqlite3(this.file)

    // WAL lets readers proceed during a write, which matters once the Phase 5
    // indexer runs alongside interactive queries.
    this.db.pragma('journal_mode = WAL')
    // NORMAL is the standard durability trade for WAL: safe against process
    // crash, and only at risk from OS-level power loss.
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    // Wait rather than immediately throwing SQLITE_BUSY under contention.
    this.db.pragma('busy_timeout = 5000')

    this.migrate()
    log.info(`opened ${this.file} at schema v${this.schemaVersion()}`)
  }

  /**
   * Applies pending migrations in order. Forward-only: a database newer than this
   * build is a hard error rather than a silent downgrade, because opening it
   * read-write with an older schema is how data gets corrupted.
   */
  private migrate(): void {
    const db = this.require()
    const current = this.schemaVersion()

    if (current > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `Database schema v${current} is newer than this build supports (v${LATEST_SCHEMA_VERSION}). ` +
          `Refusing to open to avoid data loss.`
      )
    }

    const pending = migrations.filter((m) => m.version > current)
    if (pending.length === 0) return

    for (const migration of pending) {
      log.info(`applying migration ${migration.version} (${migration.name})`)
      // `exec` cannot run inside a prepared transaction, so drive BEGIN/COMMIT
      // directly. A throw leaves us in the rollback path with the version pragma
      // untouched, so the migration is retried cleanly on next launch.
      db.exec('BEGIN')
      try {
        db.exec(migration.sql)
        db.pragma(`user_version = ${migration.version}`)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        log.error(`migration ${migration.version} (${migration.name}) failed`, error)
        throw error
      }
    }
  }

  schemaVersion(): number {
    const rows = this.require().pragma('user_version') as Array<{ user_version: number }>
    return rows[0]?.user_version ?? 0
  }

  status(): DatabaseStatus {
    const db = this.require()
    const journal = db.pragma('journal_mode', { simple: true }) as string
    const fk = db.pragma('foreign_keys', { simple: true }) as number
    const version = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    return {
      path: this.file,
      sqliteVersion: version.v,
      schemaVersion: this.schemaVersion(),
      walEnabled: journal.toLowerCase() === 'wal',
      foreignKeysEnabled: fk === 1
    }
  }

  /**
   * Spike B round-trip: write a row, read it back, delete it. Exercises the
   * native binding end to end from whatever build is actually running.
   */
  probeRoundTrip(): boolean {
    const db = this.require()
    const note = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const insert = db.prepare('INSERT INTO diagnostics_probe (created_at, note) VALUES (?, ?)')
    const info = insert.run(Date.now(), note)
    const row = db.prepare('SELECT note FROM diagnostics_probe WHERE id = ?').get(info.lastInsertRowid) as
      | { note: string }
      | undefined
    db.prepare('DELETE FROM diagnostics_probe WHERE id = ?').run(info.lastInsertRowid)
    return row?.note === note
  }

  /**
   * Loads a SQLite loadable extension into this connection.
   *
   * Separate from `open()` and never called during migration: an extension is
   * an optional capability, and a browser that will not start because a search
   * feature's DLL is missing has its priorities backwards. Callers get a boolean
   * and are expected to carry on without it.
   */
  loadExtension(path: string): boolean {
    try {
      this.require().loadExtension(path)
      return true
    } catch (error) {
      log.warn(`could not load SQLite extension at ${path}`, error)
      return false
    }
  }

  get connection(): SqliteDatabase {
    return this.require()
  }

  close(): void {
    if (!this.db) return
    // Collapse the WAL back into the main file so a copy of the .db is complete.
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch (error) {
      log.warn('wal checkpoint on close failed', error)
    }
    this.db.close()
    this.db = null
    log.info('closed')
  }

  private require(): SqliteDatabase {
    if (!this.db) throw new Error('Database used before open() or after close()')
    return this.db
  }
}
