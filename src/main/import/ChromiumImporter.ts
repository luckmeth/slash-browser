import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import {
  MAX_IMPORTED_HISTORY,
  type ImportSource,
  type ImportSummary
} from '@shared/types/importer'
import type { BookmarkRepository } from '../db/repositories/BookmarkRepository'
import type { HistoryRepository } from '../db/repositories/HistoryRepository'
import { createLogger } from '../logger'
import { chromeTimeToUnixMs, isImportableUrl, readBookmarkRoots, type ImportedBookmark } from './chromiumData'

const log = createLogger('import')

/**
 * Chromium browsers we know how to read, and where they keep their profiles.
 *
 * All of them share Chromium's on-disk layout, so one reader serves every entry
 * here — adding a browser is a line in this table, not new code.
 */
const KNOWN_BROWSERS: ReadonlyArray<{ name: string; segments: string[] }> = [
  { name: 'Google Chrome', segments: ['Google', 'Chrome', 'User Data'] },
  { name: 'Microsoft Edge', segments: ['Microsoft', 'Edge', 'User Data'] },
  { name: 'Brave', segments: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
  { name: 'Vivaldi', segments: ['Vivaldi', 'User Data'] },
  { name: 'Opera', segments: ['Programs', 'Opera', 'User Data'] }
]

/**
 * Imports bookmarks and history from another Chromium browser.
 *
 * **Scope is bookmarks and history only, and that is a decision.** Chromium's
 * saved passwords and cookies are encrypted with DPAPI against the user's
 * Windows account, so this process *could* decrypt them. It does not. Silently
 * lifting someone's entire credential store because they clicked "Import" is not
 * something a browser should do on the strength of one button, and a feature
 * that reads passwords needs to say so loudly and ask separately. The UI states
 * what is and is not carried across.
 *
 * The History database is copied before being read. Chromium holds a lock on it
 * while running, so reading in place fails for anyone who has not quit their
 * other browser first — which, on a screen offering to import from it, is
 * almost everyone.
 */
export class ChromiumImporter {
  constructor(
    private readonly bookmarks: BookmarkRepository,
    private readonly history: HistoryRepository
  ) {}

  /**
   * Profiles found on this machine.
   *
   * Only reports what is actually there: a profile directory with at least one
   * readable file. Listing a browser the user does not have, or a profile with
   * nothing in it, turns the import screen into a set of dead ends.
   */
  discover(): ImportSource[] {
    const localAppData = process.env['LOCALAPPDATA']
    if (!localAppData) return []

    const sources: ImportSource[] = []
    for (const browser of KNOWN_BROWSERS) {
      const userData = join(localAppData, ...browser.segments)
      if (!existsSync(userData)) continue

      for (const profileDir of profileDirectories(userData)) {
        const path = join(userData, profileDir)
        const hasBookmarks = existsSync(join(path, 'Bookmarks'))
        const hasHistory = existsSync(join(path, 'History'))
        if (!hasBookmarks && !hasHistory) continue

        sources.push({
          id: `${browser.name}::${profileDir}`,
          browser: browser.name,
          profile: displayName(userData, profileDir),
          hasBookmarks,
          hasHistory
        })
      }
    }
    return sources
  }

  /**
   * Runs an import.
   *
   * Each half is attempted independently and failures are collected rather than
   * thrown: getting bookmarks across when history was locked is a better outcome
   * than an error that discards both, and reporting "failed" for a half-success
   * only sends the user round again.
   */
  run(sourceId: string, options: { bookmarks: boolean; history: boolean }): ImportSummary {
    const source = this.discover().find((candidate) => candidate.id === sourceId)
    if (!source) {
      return emptySummary('That browser profile is no longer on this machine.')
    }

    const localAppData = process.env['LOCALAPPDATA'] ?? ''
    const browser = KNOWN_BROWSERS.find((known) => known.name === source.browser)
    if (!browser) return emptySummary('That browser is not one Slash knows how to read.')

    // The id is ours, built in `discover` from a directory listing, and it has
    // just been matched against a freshly discovered source — so the profile
    // segment cannot be an arbitrary path from the renderer.
    const profileDir = sourceId.slice(sourceId.indexOf('::') + 2)
    const path = join(localAppData, ...browser.segments, profileDir)

    const warnings: string[] = []
    const summary: ImportSummary = emptySummary(null)

    if (options.bookmarks && source.hasBookmarks) {
      try {
        const result = this.importBookmarks(join(path, 'Bookmarks'), source)
        summary.bookmarksAdded = result.added
        summary.bookmarksSkipped = result.skipped
      } catch (error) {
        log.error('bookmark import failed', error)
        warnings.push('Bookmarks could not be read.')
      }
    }

    if (options.history && source.hasHistory) {
      try {
        const result = this.importHistory(join(path, 'History'))
        summary.historyAdded = result.added
        summary.historyMerged = result.merged
      } catch (error) {
        log.error('history import failed', error)
        warnings.push(
          'History could not be read. Closing that browser and trying again usually fixes it.'
        )
      }
    }

    summary.warning = warnings.length > 0 ? warnings.join(' ') : null
    log.info(
      `imported from ${source.browser} — ${summary.bookmarksAdded} bookmark(s), ` +
        `${summary.historyAdded} page(s)`
    )
    return summary
  }

  private importBookmarks(
    file: string,
    source: ImportSource
  ): { added: number; skipped: number } {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const roots = readBookmarkRoots(parsed)
    if (roots.length === 0) return { added: 0, skipped: 0 }

    // Everything lands inside one dated folder rather than being merged into the
    // existing tree. An import that scatters hundreds of links through someone's
    // own carefully arranged bookmarks is not undoable by hand; one folder is
    // deletable in a single action if they change their mind.
    const container = this.bookmarks.create({
      url: '',
      title: `${source.browser} — imported ${new Date().toLocaleDateString()}`,
      faviconUrl: null,
      parentId: null,
      isFolder: true
    })

    let added = 0
    let skipped = 0

    const walk = (node: ImportedBookmark, parentId: number): void => {
      for (const child of node.children) {
        if (child.url === null) {
          const folder = this.bookmarks.create({
            url: '',
            title: child.title || 'Folder',
            faviconUrl: null,
            parentId,
            isFolder: true,
            ...(child.addedAt !== null ? { createdAt: child.addedAt } : {})
          })
          walk(child, folder.id)
          continue
        }

        // Already saved here — importing it again would leave two rows that
        // differ only by which browser they came from.
        if (this.bookmarks.findByUrl(child.url)) {
          skipped++
          continue
        }

        this.bookmarks.create({
          url: child.url,
          title: child.title,
          faviconUrl: null,
          parentId,
          isFolder: false,
          ...(child.addedAt !== null ? { createdAt: child.addedAt } : {})
        })
        added++
      }
    }

    for (const root of roots) {
      const folder = this.bookmarks.create({
        url: '',
        title: root.title,
        faviconUrl: null,
        parentId: container.id,
        isFolder: true
      })
      walk(root, folder.id)
    }

    // An import where everything was already bookmarked leaves empty folders
    // behind; better to remove the container than to add visible clutter that
    // represents nothing.
    if (added === 0) this.bookmarks.delete(container.id)

    return { added, skipped }
  }

  private importHistory(file: string): { added: number; merged: number } {
    // Chromium keeps a lock on History while it is running, so it is copied
    // first. The -wal file comes too: without it, recent browsing sits in the
    // write-ahead log and is invisible to a reader of the main file alone.
    const scratch = mkdtempSync(join(tmpdir(), 'slash-import-'))
    try {
      const copy = join(scratch, 'History')
      copyFileSync(file, copy)
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix)
      }

      const source = new BetterSqlite3(copy, { readonly: true })
      try {
        const rows = source
          .prepare(
            `SELECT url, title, visit_count, last_visit_time
             FROM urls
             WHERE hidden = 0
             ORDER BY last_visit_time DESC
             LIMIT ?`
          )
          .all(MAX_IMPORTED_HISTORY) as Array<{
          url: string
          title: string
          visit_count: number
          last_visit_time: number
        }>

        let added = 0
        let merged = 0

        // One transaction for the whole import: twenty thousand individual
        // commits would take minutes and leave a half-import behind if anything
        // went wrong in the middle.
        const write = this.historyTransaction(rows)
        const result = write()
        added = result.added
        merged = result.merged

        return { added, merged }
      } finally {
        source.close()
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  private historyTransaction(
    rows: ReadonlyArray<{ url: string; title: string; visit_count: number; last_visit_time: number }>
  ): () => { added: number; merged: number } {
    return this.history.transaction(() => {
      let added = 0
      let merged = 0
      for (const row of rows) {
        if (typeof row.url !== 'string' || !isImportableUrl(row.url)) continue
        const at = chromeTimeToUnixMs(row.last_visit_time)
        // A row with no usable timestamp is skipped rather than dated today: a
        // page you last opened years ago must not jump to the top of history.
        if (at === null) continue

        const outcome = this.history.importVisit(row.url, row.title ?? '', row.visit_count, at)
        if (outcome.added) added++
        else merged++
      }
      return { added, merged }
    })
  }
}

/** Chromium profile directories: "Default", "Profile 1", "Profile 2", … */
function profileDirectories(userData: string): string[] {
  try {
    return readdirSync(userData, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name === 'Default' || /^Profile \d+$/.test(name))
      .sort()
  } catch {
    return []
  }
}

/**
 * The name the user gave a profile, from Chromium's `Local State`.
 *
 * "Profile 3" means nothing to anyone; "Work" does. Falls back to the directory
 * name when the file is missing or unreadable, which is a cosmetic loss only.
 */
function displayName(userData: string, profileDir: string): string {
  try {
    const state: unknown = JSON.parse(readFileSync(join(userData, 'Local State'), 'utf8'))
    const cache = (state as { profile?: { info_cache?: Record<string, { name?: unknown }> } })
      ?.profile?.info_cache
    const name = cache?.[profileDir]?.name
    if (typeof name === 'string' && name.trim() !== '') return name
  } catch {
    // Cosmetic only — fall through to the directory name.
  }
  return profileDir
}

function emptySummary(warning: string | null): ImportSummary {
  return {
    bookmarksAdded: 0,
    bookmarksSkipped: 0,
    historyAdded: 0,
    historyMerged: 0,
    warning
  }
}
