import type {
  PermissionEvent,
  PermissionGrant,
  PermissionKind,
  PermissionPolicy
} from '@shared/types/permission'
import type { Database } from '../Database'

interface GrantRow {
  id: number
  partition: string
  origin: string
  kind: string
  policy: string
  expires_at: number | null
  tab_id: string | null
  created_at: number
}

interface EventRow {
  id: number
  partition: string
  origin: string
  kind: string
  action: string
  policy: string | null
  at: number
}

function toGrant(row: GrantRow): PermissionGrant {
  return {
    id: row.id,
    partition: row.partition,
    origin: row.origin,
    kind: row.kind as PermissionKind,
    policy: row.policy as PermissionPolicy,
    expiresAt: row.expires_at,
    tabId: row.tab_id,
    createdAt: row.created_at
  }
}

export class PermissionRepository {
  constructor(private readonly db: Database) {}

  /** The stored decision for this exact triple, if one exists and is unexpired. */
  find(partition: string, origin: string, kind: PermissionKind): PermissionGrant | null {
    const row = this.db.connection
      .prepare(
        `SELECT * FROM permission_grants
         WHERE partition = ? AND origin = ? AND kind = ?`
      )
      .get(partition, origin, kind) as GrantRow | undefined
    if (!row) return null

    // Expiry is enforced on read as well as by the sweeper. The sweeper runs on
    // a timer, so between ticks a lapsed grant would otherwise still answer yes.
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.deleteById(row.id)
      this.logEvent(partition, origin, row.kind as PermissionKind, 'expired', null)
      return null
    }
    return toGrant(row)
  }

  upsert(grant: Omit<PermissionGrant, 'id' | 'createdAt'>): void {
    this.db.connection
      .prepare(
        `INSERT INTO permission_grants
           (partition, origin, kind, policy, expires_at, tab_id, created_at)
         VALUES (@partition, @origin, @kind, @policy, @expiresAt, @tabId, @now)
         ON CONFLICT(partition, origin, kind) DO UPDATE SET
           policy     = excluded.policy,
           expires_at = excluded.expires_at,
           tab_id     = excluded.tab_id,
           created_at = excluded.created_at`
      )
      .run({
        partition: grant.partition,
        origin: grant.origin,
        kind: grant.kind,
        policy: grant.policy,
        expiresAt: grant.expiresAt,
        tabId: grant.tabId,
        now: Date.now()
      })
  }

  list(): PermissionGrant[] {
    const rows = this.db.connection
      .prepare('SELECT * FROM permission_grants ORDER BY origin, kind')
      .all() as GrantRow[]
    return rows.map(toGrant)
  }

  deleteById(id: number): void {
    this.db.connection.prepare('DELETE FROM permission_grants WHERE id = ?').run(id)
  }

  deleteFor(partition: string, origin: string, kind: PermissionKind): void {
    this.db.connection
      .prepare('DELETE FROM permission_grants WHERE partition = ? AND origin = ? AND kind = ?')
      .run(partition, origin, kind)
  }

  /** Removes lapsed grants. Returns them so each can be logged and announced. */
  sweepExpired(now: number): PermissionGrant[] {
    const rows = this.db.connection
      .prepare('SELECT * FROM permission_grants WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .all(now) as GrantRow[]
    if (rows.length === 0) return []

    const remove = this.db.connection.prepare('DELETE FROM permission_grants WHERE id = ?')
    const removeAll = this.db.connection.transaction((all: GrantRow[]) => {
      for (const row of all) remove.run(row.id)
    })
    removeAll(rows)

    const grants = rows.map(toGrant)
    for (const grant of grants) {
      this.logEvent(grant.partition, grant.origin, grant.kind, 'expired', null)
    }
    return grants
  }

  logEvent(
    partition: string,
    origin: string,
    kind: PermissionKind,
    action: PermissionEvent['action'],
    policy: PermissionPolicy | null
  ): void {
    this.db.connection
      .prepare(
        `INSERT INTO permission_events (partition, origin, kind, action, policy, at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(partition, origin, kind, action, policy, Date.now())
  }

  listEvents(limit: number): PermissionEvent[] {
    const rows = this.db.connection
      .prepare('SELECT * FROM permission_events ORDER BY at DESC LIMIT ?')
      .all(limit) as EventRow[]
    return rows.map((row) => ({
      id: row.id,
      partition: row.partition,
      origin: row.origin,
      kind: row.kind as PermissionKind,
      action: row.action as PermissionEvent['action'],
      policy: row.policy as PermissionPolicy | null,
      at: row.at
    }))
  }

  clearEvents(): void {
    this.db.connection.prepare('DELETE FROM permission_events').run()
  }
}
