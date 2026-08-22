import { randomUUID } from 'node:crypto'
import { net } from 'electron'
import { z } from 'zod'
import { decrypt, deriveKey, encrypt, verifier, verifierMatches } from './crypto'
import { mergeItems, nextCursor, type SyncItem } from './merge'
import type { Database } from '../db/Database'
import type { SettingsStore } from '../settings/SettingsStore'
import { createLogger } from '../logger'

const log = createLogger('sync')

/** Tombstones are kept this long, so a device offline for a while still learns of deletions. */
const TOMBSTONE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000

const RemoteItemSchema = z.object({
  id: z.string().min(1).max(200),
  collection: z.string().min(1).max(40),
  updatedAt: z.number(),
  deleted: z.boolean(),
  payload: z.string().max(200_000)
})

const PullSchema = z.object({
  cursor: z.number(),
  salt: z.string().default(''),
  verifier: z.string().default(''),
  items: z.array(RemoteItemSchema).max(5000)
})

export interface SyncStatus {
  enabled: boolean
  configured: boolean
  unlocked: boolean
  deviceId: string
  lastSyncAt: number | null
  lastError: string | null
  itemCount: number
}

interface StateRow {
  device_id: string
  cursor: number
  salt: string
  verifier: string
  last_sync_at: number | null
  last_error: string | null
}

/**
 * Syncing bookmarks and the reading list between machines.
 *
 * **End-to-end encrypted, and that is not decoration.** The server stores
 * ciphertext and a timestamp; it never sees a URL, a title, or anything else.
 * Sync that uploaded readable bookmarks would have turned this browser's
 * local-first claim into a slogan, so the passphrase never leaves the machine
 * and no key derived from it is stored — it is derived on unlock and held in
 * memory only.
 *
 * The cost is stated in the settings copy rather than discovered: **forget the
 * passphrase and the synced data cannot be recovered**, because there is
 * deliberately nobody holding a spare.
 *
 * History is not synced. It is the largest and most revealing thing the browser
 * holds, and pushing it to a server — even encrypted — is a different promise
 * from the one on the box. Bookmarks and reading list are what people actually
 * ask for.
 */
export class SyncService {
  /** Derived on unlock, never written to disk. */
  private key: Buffer | null = null

  constructor(
    private readonly db: Database,
    private readonly settings: SettingsStore,
    private readonly onChanged: () => void
  ) {}

  private get endpoint(): string {
    return this.settings.getAll().syncEndpoint.trim()
  }

  private get active(): boolean {
    return this.settings.getAll().syncEnabled && this.endpoint !== ''
  }

  /** Creates the single state row on first use. */
  private state(): StateRow {
    const existing = this.db.connection
      .prepare<[], StateRow>('SELECT * FROM sync_state WHERE id = 1')
      .get()
    if (existing) return existing

    const deviceId = randomUUID()
    this.db.connection
      .prepare('INSERT INTO sync_state (id, device_id, cursor) VALUES (1, ?, 0)')
      .run(deviceId)
    return { device_id: deviceId, cursor: 0, salt: '', verifier: '', last_sync_at: null, last_error: null }
  }

  status(): SyncStatus {
    const state = this.state()
    const count = this.localItems().filter((item) => !item.deleted).length
    return {
      enabled: this.settings.getAll().syncEnabled,
      configured: this.endpoint !== '',
      unlocked: this.key !== null,
      deviceId: state.device_id,
      lastSyncAt: state.last_sync_at,
      lastError: state.last_error,
      itemCount: count
    }
  }

  /**
   * Derives the key from a passphrase and checks it against the account.
   *
   * The verifier is what separates "wrong passphrase" from "nothing synced
   * yet". Without it a typo looks exactly like a fresh account, and the user
   * cheerfully starts a second history that will never merge with the first.
   */
  async unlock(passphrase: string): Promise<{ ok: boolean; problem: string }> {
    if (passphrase.length < 8) {
      return { ok: false, problem: 'Use at least 8 characters — this is the only thing protecting the data.' }
    }

    const state = this.state()

    // A salt already known locally is reused; otherwise ask the server, so a
    // second device derives the same key as the first.
    let salt = state.salt
    let expected = state.verifier

    if (salt === '' && this.endpoint !== '') {
      try {
        const remote = await this.pull(0)
        if (remote?.salt) {
          salt = remote.salt
          expected = remote.verifier
        }
      } catch {
        // Unreachable server: fall through to creating a local account rather
        // than refusing to set a passphrase at all.
      }
    }

    const derived = deriveKey(passphrase, salt === '' ? undefined : salt)

    if (expected !== '' && !verifierMatches(derived.key, expected)) {
      return {
        ok: false,
        problem: 'That passphrase does not match the one this account was set up with.'
      }
    }

    this.key = derived.key
    this.db.connection
      .prepare('UPDATE sync_state SET salt = ?, verifier = ? WHERE id = 1')
      .run(derived.salt, verifier(derived.key))
    this.onChanged()
    return { ok: true, problem: '' }
  }

  /** Forgets the in-memory key. The data stays; it simply cannot be read until unlocked again. */
  lock(): void {
    this.key = null
    this.onChanged()
  }

  /**
   * One full cycle: pull, merge, apply, push.
   *
   * Silent on failure by design — an unreachable sync server is not the user's
   * problem mid-browse, and the state row records the reason for the settings
   * screen to show.
   */
  async sync(): Promise<SyncStatus> {
    if (!this.active || !this.key) return this.status()

    const state = this.state()
    try {
      const remote = await this.pull(state.cursor)
      if (!remote) throw new Error('the sync server did not answer in a usable way')

      const local = this.localItems()
      const { toApply, toPush } = mergeItems(local, remote.items)

      this.applyRemote(toApply)
      if (toPush.length > 0) await this.push(toPush)

      const cursor = nextCursor(remote.items, state.cursor)
      this.db.connection
        .prepare('UPDATE sync_state SET cursor = ?, last_sync_at = ?, last_error = NULL WHERE id = 1')
        .run(cursor, Date.now())

      this.pruneTombstones()
      log.info(`sync: ${toApply.length} in, ${toPush.length} out`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed.'
      this.db.connection.prepare('UPDATE sync_state SET last_error = ? WHERE id = 1').run(message)
      log.warn('sync failed', error)
    }

    this.onChanged()
    return this.status()
  }

  // --- projecting the database into sync items -------------------------------

  /**
   * Everything this machine would offer, encrypted.
   *
   * Bookmarks travel by `guid` and reading-list items by URL, because the
   * integer primary keys are local: two devices each creating a bookmark would
   * both call it 7.
   */
  private localItems(): SyncItem[] {
    if (!this.key) return []
    const key = this.key
    const items: SyncItem[] = []

    const bookmarks = this.db.connection
      .prepare<[], {
        guid: string
        url: string | null
        title: string
        favicon_url: string | null
        is_folder: number
        sort_order: number
        updated_at: number
        parent_guid: string | null
      }>(
        `SELECT b.guid, b.url, b.title, b.favicon_url, b.is_folder, b.sort_order, b.updated_at,
                p.guid AS parent_guid
           FROM bookmarks b LEFT JOIN bookmarks p ON p.id = b.parent_id
          WHERE b.guid IS NOT NULL`
      )
      .all()

    for (const row of bookmarks) {
      items.push({
        id: row.guid,
        collection: 'bookmarks',
        updatedAt: row.updated_at,
        deleted: false,
        payload: encrypt(
          key,
          JSON.stringify({
            url: row.url,
            title: row.title,
            faviconUrl: row.favicon_url,
            isFolder: row.is_folder === 1,
            sortOrder: row.sort_order,
            // The parent travels as a guid, not an id — an integer parent would
            // point at a different bookmark on every other machine.
            parentGuid: row.parent_guid
          })
        )
      })
    }

    const reading = this.db.connection
      .prepare<[], {
        url: string
        title: string
        favicon_url: string | null
        added_at: number
        read_at: number | null
        updated_at: number
      }>('SELECT url, title, favicon_url, added_at, read_at, updated_at FROM reading_list')
      .all()

    for (const row of reading) {
      items.push({
        id: row.url,
        collection: 'reading',
        updatedAt: row.updated_at,
        deleted: false,
        payload: encrypt(
          key,
          JSON.stringify({
            url: row.url,
            title: row.title,
            faviconUrl: row.favicon_url,
            addedAt: row.added_at,
            readAt: row.read_at
          })
        )
      })
    }

    const tombstones = this.db.connection
      .prepare<[], { collection: string; item_id: string; deleted_at: number }>(
        'SELECT collection, item_id, deleted_at FROM sync_tombstones'
      )
      .all()

    for (const row of tombstones) {
      items.push({
        id: row.item_id,
        collection: row.collection,
        updatedAt: row.deleted_at,
        deleted: true,
        // Nothing to carry: a tombstone says only that this id is gone.
        payload: ''
      })
    }

    return items
  }

  /** Writes what the server had and this machine did not. */
  private applyRemote(items: readonly SyncItem[]): void {
    if (!this.key || items.length === 0) return
    const key = this.key

    const apply = this.db.connection.transaction(() => {
      for (const item of items) {
        if (item.deleted) {
          this.applyDeletion(item)
          continue
        }

        const json = decrypt(key, item.payload)
        if (json === null) {
          // Written with a different passphrase, or damaged. Skipped rather than
          // failing the whole sync — the rest of the data is fine.
          log.warn(`could not decrypt ${item.collection}/${item.id}; skipped`)
          continue
        }

        try {
          if (item.collection === 'bookmarks') this.applyBookmark(item, JSON.parse(json))
          else if (item.collection === 'reading') this.applyReading(item, JSON.parse(json))
        } catch (error) {
          log.warn(`could not apply ${item.collection}/${item.id}`, error)
        }
      }
    })
    apply()
  }

  private applyDeletion(item: SyncItem): void {
    if (item.collection === 'bookmarks') {
      this.db.connection.prepare('DELETE FROM bookmarks WHERE guid = ?').run(item.id)
    } else if (item.collection === 'reading') {
      this.db.connection.prepare('DELETE FROM reading_list WHERE url = ?').run(item.id)
    }
    this.db.connection
      .prepare(
        `INSERT INTO sync_tombstones (collection, item_id, deleted_at) VALUES (?, ?, ?)
         ON CONFLICT(collection, item_id) DO UPDATE SET deleted_at = excluded.deleted_at`
      )
      .run(item.collection, item.id, item.updatedAt)
  }

  private applyBookmark(item: SyncItem, data: Record<string, unknown>): void {
    const parentGuid = typeof data.parentGuid === 'string' ? data.parentGuid : null
    const parent = parentGuid
      ? (this.db.connection
          .prepare<[string], { id: number }>('SELECT id FROM bookmarks WHERE guid = ?')
          .get(parentGuid)?.id ?? null)
      : null

    this.db.connection
      .prepare(
        `INSERT INTO bookmarks (guid, url, title, favicon_url, parent_id, is_folder, sort_order,
                                created_at, updated_at)
         VALUES (@guid, @url, @title, @favicon, @parent, @isFolder, @sortOrder, @now, @updatedAt)
         ON CONFLICT(guid) DO UPDATE SET
           url = excluded.url, title = excluded.title, favicon_url = excluded.favicon_url,
           parent_id = excluded.parent_id, sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`
      )
      .run({
        guid: item.id,
        url: data.isFolder === true ? null : String(data.url ?? ''),
        title: String(data.title ?? ''),
        favicon: typeof data.faviconUrl === 'string' ? data.faviconUrl : null,
        parent,
        isFolder: data.isFolder === true ? 1 : 0,
        sortOrder: Number(data.sortOrder ?? 0),
        now: Date.now(),
        updatedAt: item.updatedAt
      })
  }

  private applyReading(item: SyncItem, data: Record<string, unknown>): void {
    this.db.connection
      .prepare(
        `INSERT INTO reading_list (url, title, favicon_url, added_at, read_at, updated_at)
         VALUES (@url, @title, @favicon, @addedAt, @readAt, @updatedAt)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title, favicon_url = excluded.favicon_url,
           read_at = excluded.read_at, updated_at = excluded.updated_at`
      )
      .run({
        url: item.id,
        title: String(data.title ?? ''),
        favicon: typeof data.faviconUrl === 'string' ? data.faviconUrl : null,
        addedAt: Number(data.addedAt ?? Date.now()),
        readAt: typeof data.readAt === 'number' ? data.readAt : null,
        updatedAt: item.updatedAt
      })
  }

  private pruneTombstones(): void {
    this.db.connection
      .prepare('DELETE FROM sync_tombstones WHERE deleted_at < ?')
      .run(Date.now() - TOMBSTONE_MAX_AGE_MS)
  }

  // --- transport -------------------------------------------------------------

  private async pull(cursor: number): Promise<z.infer<typeof PullSchema> | null> {
    const state = this.state()
    const url = new URL(this.endpoint)
    url.searchParams.set('since', String(cursor))
    url.searchParams.set('device', state.device_id)

    const response = await net.fetch(url.toString(), {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      headers: { accept: 'application/json', ...this.authHeader() }
    })
    if (!response.ok) throw new Error(`The sync server returned ${response.status}.`)

    const parsed = PullSchema.safeParse(await response.json())
    return parsed.success ? parsed.data : null
  }

  private async push(items: readonly SyncItem[]): Promise<void> {
    const state = this.state()
    const response = await net.fetch(this.endpoint, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...this.authHeader() },
      body: JSON.stringify({
        device: state.device_id,
        salt: state.salt,
        verifier: state.verifier,
        items
      })
    })
    if (!response.ok) throw new Error(`The sync server rejected the upload (${response.status}).`)
  }

  /**
   * The account token, if one is set.
   *
   * A bearer token rather than a cookie: this is a machine-to-machine call, and
   * a cookie would be sent by anything else that happened to reach the same
   * origin.
   */
  private authHeader(): Record<string, string> {
    const token = this.settings.getAll().syncToken.trim()
    return token === '' ? {} : { authorization: `Bearer ${token}` }
  }

  /** Everything this feature holds locally, for the "forget it all" button. */
  reset(): void {
    this.key = null
    this.db.connection.prepare('DELETE FROM sync_state').run()
    this.db.connection.prepare('DELETE FROM sync_tombstones').run()
    this.onChanged()
  }
}
