import type { ReadingItem } from '@shared/types/readingList'
import type { Database } from '../Database'

interface Row {
  id: number
  url: string
  title: string
  favicon_url: string | null
  added_at: number
  read_at: number | null
}

export class ReadingListRepository {
  constructor(private readonly db: Database) {}

  /** Unread first, newest within each block — the order you would work through. */
  list(): ReadingItem[] {
    return this.db.connection
      .prepare<[], Row>(
        `SELECT id, url, title, favicon_url, added_at, read_at
           FROM reading_list
          ORDER BY (read_at IS NOT NULL), added_at DESC`
      )
      .all()
      .map(toItem)
  }

  /**
   * Adds a page, or refreshes one already saved.
   *
   * Re-saving something already in the list moves it back to unread rather than
   * creating a duplicate: saving a page again is a statement that you still
   * intend to read it.
   */
  add(item: { url: string; title: string; faviconUrl: string | null }): void {
    this.db.connection
      .prepare(
        `INSERT INTO reading_list (url, title, favicon_url, added_at, read_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title,
           favicon_url = excluded.favicon_url,
           added_at = excluded.added_at,
           read_at = NULL,
           updated_at = excluded.updated_at`
      )
      .run(item.url, item.title, item.faviconUrl, Date.now(), Date.now())

    // Re-adding something that was deleted clears the tombstone, or the next
    // sync would faithfully delete it again on this machine.
    this.db.connection
      .prepare("DELETE FROM sync_tombstones WHERE collection = 'reading' AND item_id = ?")
      .run(item.url)
  }

  remove(id: number): void {
    // The URL is the stable identity across devices — the integer id is local.
    // Read before the delete, while the row is still there to read.
    const row = this.db.connection
      .prepare<[number], { url: string }>('SELECT url FROM reading_list WHERE id = ?')
      .get(id)
    const remove = this.db.connection.transaction(() => {
      if (row) this.tombstone(row.url)
      this.db.connection.prepare('DELETE FROM reading_list WHERE id = ?').run(id)
    })
    remove()
  }

  /** Records that an item was deleted, so other devices stop offering it back. */
  private tombstone(url: string): void {
    this.db.connection
      .prepare(
        `INSERT INTO sync_tombstones (collection, item_id, deleted_at) VALUES ('reading', ?, ?)
         ON CONFLICT(collection, item_id) DO UPDATE SET deleted_at = excluded.deleted_at`
      )
      .run(url, Date.now())
  }

  /** Marked, not deleted, so it is reversible. */
  setRead(id: number, read: boolean): void {
    this.db.connection
      .prepare('UPDATE reading_list SET read_at = ?, updated_at = ? WHERE id = ?')
      .run(read ? Date.now() : null, Date.now(), id)
  }

  clearRead(): void {
    const clear = this.db.connection.transaction(() => {
      const doomed = this.db.connection
        .prepare<[], { url: string }>('SELECT url FROM reading_list WHERE read_at IS NOT NULL')
        .all()
      for (const row of doomed) this.tombstone(row.url)
      this.db.connection.prepare('DELETE FROM reading_list WHERE read_at IS NOT NULL').run()
    })
    clear()
  }

  findByUrl(url: string): ReadingItem | null {
    const row = this.db.connection
      .prepare<[string], Row>(
        `SELECT id, url, title, favicon_url, added_at, read_at
           FROM reading_list WHERE url = ?`
      )
      .get(url)
    return row ? toItem(row) : null
  }
}

function toItem(row: Row): ReadingItem {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    faviconUrl: row.favicon_url,
    addedAt: row.added_at,
    readAt: row.read_at
  }
}
