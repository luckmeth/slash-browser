import {
  DEFAULT_WORKSPACE_ID,
  type Workspace,
  type WorkspaceColor
} from '@shared/types/workspace'
import type { Database } from '../Database'

interface WorkspaceRow {
  id: string
  name: string
  icon: string
  color: string
  isolated: number
  notes: string
  sort_order: number
  created_at: number
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color as WorkspaceColor,
    isolated: row.isolated === 1,
    notes: row.notes,
    sortOrder: row.sort_order,
    createdAt: row.created_at
  }
}

export interface CreateWorkspaceInput {
  name: string
  icon: string
  color: WorkspaceColor
  isolated: boolean
}

export class WorkspaceRepository {
  constructor(private readonly db: Database) {}

  list(): Workspace[] {
    const rows = this.db.connection
      .prepare('SELECT * FROM workspaces ORDER BY sort_order, created_at')
      .all() as WorkspaceRow[]
    return rows.map(toWorkspace)
  }

  findById(id: string): Workspace | null {
    const row = this.db.connection.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      | WorkspaceRow
      | undefined
    return row ? toWorkspace(row) : null
  }

  create(input: CreateWorkspaceInput): Workspace {
    const id = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const next = this.db.connection
      .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM workspaces')
      .get() as { next: number }

    this.db.connection
      .prepare(
        `INSERT INTO workspaces (id, name, icon, color, isolated, notes, sort_order, created_at)
         VALUES (@id, @name, @icon, @color, @isolated, '', @sortOrder, @now)`
      )
      .run({
        id,
        name: input.name,
        icon: input.icon,
        color: input.color,
        isolated: input.isolated ? 1 : 0,
        sortOrder: next.next,
        now: Date.now()
      })

    return this.requireById(id)
  }

  /**
   * Updates the editable fields. `isolated` is deliberately absent — see the
   * schema comment; changing it would orphan the workspace's cookies.
   */
  update(
    id: string,
    patch: { name?: string; icon?: string; color?: WorkspaceColor; notes?: string; sortOrder?: number }
  ): Workspace {
    const existing = this.requireById(id)
    this.db.connection
      .prepare(
        `UPDATE workspaces SET name = @name, icon = @icon, color = @color,
           notes = @notes, sort_order = @sortOrder
         WHERE id = @id`
      )
      .run({
        id,
        name: patch.name ?? existing.name,
        icon: patch.icon ?? existing.icon,
        color: patch.color ?? existing.color,
        notes: patch.notes ?? existing.notes,
        sortOrder: patch.sortOrder ?? existing.sortOrder
      })
    return this.requireById(id)
  }

  /** The default workspace is not deletable — a tab must always have a home. */
  delete(id: string): boolean {
    if (id === DEFAULT_WORKSPACE_ID) return false
    const info = this.db.connection.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
    return info.changes > 0
  }

  private requireById(id: string): Workspace {
    const found = this.findById(id)
    if (!found) throw new Error(`Workspace ${id} not found`)
    return found
  }
}
