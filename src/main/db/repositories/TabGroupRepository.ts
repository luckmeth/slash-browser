import type { TabGroup } from '@shared/types/tabGroup'
import type { WorkspaceColor } from '@shared/types/workspace'
import type { Database } from '../Database'

interface Row {
  id: string
  workspace_id: string
  name: string
  color: string
  collapsed: number
  created_at: number
}

/**
 * Tab groups on disk.
 *
 * Written through on every change rather than flushed at quit: a group is the
 * product of the user naming and sorting things, and a crash that loses that
 * teaches them not to bother doing it again.
 */
export class TabGroupRepository {
  constructor(private readonly db: Database) {}

  list(): TabGroup[] {
    return this.db.connection
      .prepare<[], Row>(
        `SELECT id, workspace_id, name, color, collapsed, created_at
           FROM tab_groups ORDER BY created_at`
      )
      .all()
      .map(toGroup)
  }

  create(group: TabGroup): void {
    this.db.connection
      .prepare(
        `INSERT INTO tab_groups (id, workspace_id, name, color, collapsed, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        group.id,
        group.workspaceId,
        group.name,
        group.color,
        group.collapsed ? 1 : 0,
        group.createdAt
      )
  }

  update(id: string, patch: { name?: string; color?: string; collapsed?: boolean }): void {
    // Built from whichever fields were supplied, so a rename never silently
    // rewrites a colour the caller did not mention.
    const sets: string[] = []
    const values: (string | number)[] = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      values.push(patch.name)
    }
    if (patch.color !== undefined) {
      sets.push('color = ?')
      values.push(patch.color)
    }
    if (patch.collapsed !== undefined) {
      sets.push('collapsed = ?')
      values.push(patch.collapsed ? 1 : 0)
    }
    if (sets.length === 0) return
    values.push(id)
    this.db.connection.prepare(`UPDATE tab_groups SET ${sets.join(', ')} WHERE id = ?`).run(values)
  }

  delete(id: string): void {
    this.db.connection.prepare('DELETE FROM tab_groups WHERE id = ?').run(id)
  }

  /**
   * Drops groups no tab belongs to any more.
   *
   * Group membership lives on the in-memory tab, so a group whose tabs were all
   * closed leaves a row behind with nothing in it. Called at startup with the
   * ids still in use rather than on every close, because the empty state is
   * legitimate while a user is rearranging.
   */
  pruneExcept(keepIds: readonly string[]): void {
    if (keepIds.length === 0) {
      this.db.connection.prepare('DELETE FROM tab_groups').run()
      return
    }
    const placeholders = keepIds.map(() => '?').join(', ')
    this.db.connection
      .prepare(`DELETE FROM tab_groups WHERE id NOT IN (${placeholders})`)
      .run(keepIds)
  }
}

function toGroup(row: Row): TabGroup {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    color: row.color as WorkspaceColor,
    collapsed: row.collapsed === 1,
    createdAt: row.created_at
  }
}
