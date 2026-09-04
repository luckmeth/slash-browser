import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Storage for the sponsor portal.
 *
 * SQLite for the same reason the browser uses it: one file, no server to run
 * beside this one, and a backup is a file copy. A portal that needed Postgres
 * before it had a single advertiser would be the wrong shape.
 */
export function openDatabase(file = resolve('data/portal.db')) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      email        TEXT    NOT NULL UNIQUE,
      -- scrypt, with a per-account salt. Never the password itself.
      password_key TEXT    NOT NULL,
      salt         TEXT    NOT NULL,
      is_admin     INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id  INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      headline    TEXT    NOT NULL,
      body        TEXT    NOT NULL DEFAULT '',
      -- A data: URL. Stored as given and re-checked before it is ever served,
      -- because a remote image would become a per-impression request to the
      -- advertiser -- a tracking pixel -- and the browser refuses those anyway.
      image       TEXT    NOT NULL DEFAULT '',
      click_url   TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
      note        TEXT    NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      reviewed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns (status, created_at DESC);

    -- Exactly what the browser reports: per creative, per day. Nothing finer
    -- arrives, so nothing finer can be stored.
    CREATE TABLE IF NOT EXISTS counts (
      campaign_id INTEGER NOT NULL,
      day         TEXT    NOT NULL,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (campaign_id, day)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
  `)

  return db
}
