import type { Mission, MissionItem } from '@shared/types/mission'
import type { Database } from '../db/Database'
import { createLogger } from '../logger'
import { scoreRelevance, suggestionFor } from './missionRelevance'

const log = createLogger('mission')

interface MissionRow {
  id: number
  goal: string
  notes: string
  active: number
  created_at: number
  completed_at: number | null
}

interface ItemRow {
  id: number
  mission_id: number
  url: string
  title: string
  kind: 'page' | 'saved'
  added_at: number
}

/**
 * Mission Mode.
 *
 * Holds the goal, the pages that accumulated around it, the digressions saved for
 * later, and the notes. It suggests, and it never restricts: `suggestionFor` is
 * the only thing that acts on relevance, and all it does is produce a sentence.
 */
export class MissionService {
  constructor(private readonly db: Database) {}

  /**
   * Starts a mission, ending any other.
   *
   * Exactly one at a time on purpose. Two simultaneous "current goals" makes the
   * relevance suggestion incoherent — a page is off one and on the other — and
   * the user has no way to say which they meant.
   */
  start(goal: string): Mission {
    const trimmed = goal.trim()
    this.db.connection
      .prepare('UPDATE missions SET active = 0, completed_at = COALESCE(completed_at, ?) WHERE active = 1')
      .run(Date.now())

    const info = this.db.connection
      .prepare(
        `INSERT INTO missions (goal, notes, active, created_at)
         VALUES (@goal, @notes, 1, @now)`
      )
      .run({ goal: trimmed, notes: '', now: Date.now() })

    log.info(`mission started: ${trimmed.slice(0, 60)}`)
    return this.require(Number(info.lastInsertRowid))
  }

  /** Marks the active mission finished. Its pages and notes are kept. */
  complete(): void {
    this.db.connection
      .prepare('UPDATE missions SET active = 0, completed_at = ? WHERE active = 1')
      .run(Date.now())
  }

  /** Deletes a mission and everything attached to it. */
  discard(id: number): void {
    this.db.connection.prepare('DELETE FROM missions WHERE id = ?').run(id)
  }

  setNotes(id: number, notes: string): void {
    this.db.connection.prepare('UPDATE missions SET notes = ? WHERE id = ?').run(notes, id)
  }

  /** Adds a page to the mission, or to its for-later pile. */
  addItem(id: number, url: string, title: string, kind: 'page' | 'saved'): void {
    this.db.connection
      .prepare(
        `INSERT INTO mission_items (mission_id, url, title, kind, added_at)
         VALUES (@id, @url, @title, @kind, @now)
         ON CONFLICT(mission_id, url, kind) DO UPDATE SET title = excluded.title`
      )
      .run({ id, url, title, kind, now: Date.now() })
  }

  removeItem(itemId: number): void {
    this.db.connection.prepare('DELETE FROM mission_items WHERE id = ?').run(itemId)
  }

  active(): Mission | null {
    const row = this.db.connection
      .prepare('SELECT * FROM missions WHERE active = 1 ORDER BY created_at DESC LIMIT 1')
      .get() as MissionRow | undefined
    return row ? this.hydrate(row) : null
  }

  past(): Mission[] {
    const rows = this.db.connection
      .prepare('SELECT * FROM missions WHERE active = 0 ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 20')
      .all() as MissionRow[]
    return rows.map((row) => this.hydrate(row))
  }

  /**
   * Records a visited page against the active mission and returns a suggestion.
   *
   * On-mission pages are added silently; off-mission ones are *not* added and
   * produce the offer to save for later. Adding a digression to the mission would
   * pollute the very context the relevance judgement depends on.
   */
  notePageVisited(url: string, title: string): string | null {
    const mission = this.active()
    if (!mission || !/^https?:\/\//i.test(url)) return null

    const verdict = scoreRelevance({ url, title }, mission.goal, mission.pages)
    if (verdict.onMission) {
      this.addItem(mission.id, url, title, 'page')
      return null
    }
    return suggestionFor(verdict, mission.goal)
  }

  /**
   * A plain-language account of what the mission covered.
   *
   * Counts and hosts rather than a generated narrative: the browser knows how
   * many pages and which sites, and does not know what the user concluded.
   * Inventing a summary of their work would be making something up.
   */
  summarise(mission: Mission): string {
    const hosts = new Set<string>()
    for (const item of mission.pages) {
      try {
        hosts.add(new URL(item.url).host.replace(/^www\./, ''))
      } catch {
        // Unparseable URLs contribute no host.
      }
    }

    const parts = [
      `${mission.pages.length} page${mission.pages.length === 1 ? '' : 's'} across ${hosts.size} site${hosts.size === 1 ? '' : 's'}`
    ]
    if (mission.saved.length > 0) parts.push(`${mission.saved.length} saved for later`)
    if (mission.notes.trim() !== '') parts.push('notes kept')
    return parts.join(' · ')
  }

  private hydrate(row: MissionRow): Mission {
    const items = this.db.connection
      .prepare('SELECT * FROM mission_items WHERE mission_id = ? ORDER BY added_at DESC')
      .all(row.id) as ItemRow[]

    const map = (kind: 'page' | 'saved'): MissionItem[] =>
      items
        .filter((item) => item.kind === kind)
        .map((item) => ({
          id: item.id,
          url: item.url,
          title: item.title,
          kind: item.kind,
          addedAt: item.added_at
        }))

    return {
      id: row.id,
      goal: row.goal,
      notes: row.notes,
      active: row.active === 1,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      pages: map('page'),
      saved: map('saved')
    }
  }

  private require(id: number): Mission {
    const row = this.db.connection.prepare('SELECT * FROM missions WHERE id = ?').get(id) as
      | MissionRow
      | undefined
    if (!row) throw new Error(`Mission ${id} vanished immediately after being created`)
    return this.hydrate(row)
  }
}
