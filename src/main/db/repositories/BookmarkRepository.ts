import type { Bookmark } from '@shared/types/browsing'
import type { Database } from '../Database'

interface BookmarkRow {
  id: number
  url: string | null
  title: string
  favicon_url: string | null
  parent_id: number | null
  is_folder: number
  sort_order: number
  created_at: number
}

function toBookmark(row: BookmarkRow): Bookmark {
  return {
    id: row.id,
    // The schema guarantees a non-folder has a url; the column is nullable only
    // so folders can share the table.
    url: row.url ?? '',
    title: row.title,
    faviconUrl: row.favicon_url,
    parentId: row.parent_id,
    isFolder: row.is_folder === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at
  }
}

export interface CreateBookmarkInput {
  url: string
  title: string
  faviconUrl: string | null
  parentId: number | null
  isFolder: boolean
  /**
   * When the bookmark was originally created. Defaults to now.
   *
   * Set only by the importer, so a bookmark someone saved in 2019 does not
   * claim to have been created the moment they switched browsers.
   */
  createdAt?: number
}

export interface UpdateBookmarkInput {
  id: number
  title?: string
  url?: string
  parentId?: number | null
  sortOrder?: number
}

export class BookmarkRepository {
  constructor(private readonly db: Database) {}

  list(): Bookmark[] {
    const rows = this.db.connection
      .prepare('SELECT * FROM bookmarks ORDER BY parent_id NULLS FIRST, sort_order, id')
      .all() as BookmarkRow[]
    return rows.map(toBookmark)
  }

  create(input: CreateBookmarkInput): Bookmark {
    // Append within the target folder. Computing the order here rather than
    // trusting a client-supplied index keeps concurrent creates from colliding.
    const next = this.db.connection
      .prepare(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM bookmarks
         WHERE parent_id IS @parent`
      )
      .get({ parent: input.parentId }) as { next: number }

    const info = this.db.connection
      .prepare(
        `INSERT INTO bookmarks (url, title, favicon_url, parent_id, is_folder, sort_order, created_at)
         VALUES (@url, @title, @favicon, @parent, @isFolder, @sortOrder, @now)`
      )
      .run({
        url: input.isFolder ? null : input.url,
        title: input.title,
        favicon: input.faviconUrl,
        parent: input.parentId,
        isFolder: input.isFolder ? 1 : 0,
        sortOrder: next.next,
        now: input.createdAt ?? Date.now()
      })

    return this.requireById(Number(info.lastInsertRowid))
  }

  update(input: UpdateBookmarkInput): Bookmark {
    const existing = this.requireById(input.id)
    this.db.connection
      .prepare(
        `UPDATE bookmarks SET title = @title, url = @url, parent_id = @parent, sort_order = @sortOrder
         WHERE id = @id`
      )
      .run({
        id: input.id,
        title: input.title ?? existing.title,
        url: existing.isFolder ? null : (input.url ?? existing.url),
        parent: input.parentId === undefined ? existing.parentId : input.parentId,
        sortOrder: input.sortOrder ?? existing.sortOrder
      })
    return this.requireById(input.id)
  }

  /** Deleting a folder cascades to its children via the FK constraint. */
  delete(id: number): void {
    this.db.connection.prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
  }

  findByUrl(url: string): Bookmark | null {
    const row = this.db.connection
      .prepare('SELECT * FROM bookmarks WHERE url = ? AND is_folder = 0 LIMIT 1')
      .get(url) as BookmarkRow | undefined
    return row ? toBookmark(row) : null
  }

  findById(id: number): Bookmark | null {
    const row = this.db.connection.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as
      | BookmarkRow
      | undefined
    return row ? toBookmark(row) : null
  }

  private requireById(id: number): Bookmark {
    const found = this.findById(id)
    if (!found) throw new Error(`Bookmark ${id} not found`)
    return found
  }
}
