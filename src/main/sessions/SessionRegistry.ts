import { session, type Session } from 'electron'
import type { SessionHardening } from './SessionHardening'

/**
 * The only way to obtain a `Session`.
 *
 * Routing every acquisition through here guarantees `SessionHardening` has run
 * before the session is used. That matters most for Phase 2: an isolated
 * workspace gets its own `persist:ws-<id>` partition, and a partition created
 * anywhere else would silently start life with Chromium's defaults — permissive
 * where ours are not — while looking identical from the outside.
 */
export class SessionRegistry {
  private readonly hardened = new Set<string>()

  constructor(private readonly hardening: SessionHardening) {}

  /** The shared session used by every non-isolated workspace. */
  getDefault(): Session {
    return this.harden(session.defaultSession, 'default')
  }

  /**
   * A workspace's session.
   *
   * Non-isolated workspaces share the default session, which is what lets a tab
   * move between them instantly and stay signed in. An isolated workspace gets a
   * persistent partition with genuinely separate cookies, storage and cache —
   * and moving a tab across that boundary necessarily reloads it signed out,
   * because the credentials live in the partition, not the tab.
   */
  getForWorkspace(workspaceId: string, isolated: boolean): Session {
    if (!isolated) return this.getDefault()
    const partition = `persist:ws-${workspaceId}`
    return this.harden(session.fromPartition(partition), partition)
  }

  /**
   * Installed alongside hardening, so blocking reaches every partition.
   *
   * Set before any session is acquired. An isolated workspace browsing
   * unfiltered because its session was created through a different path is
   * exactly the kind of gap this registry exists to prevent.
   */
  setContentBlocker(blocker: { apply: (session: Session, label: string) => void }): void {
    this.blocker = blocker
  }

  private blocker: { apply: (session: Session, label: string) => void } | null = null

  private harden(target: Session, key: string): Session {
    if (!this.hardened.has(key)) {
      this.hardening.apply(target, key)
      this.blocker?.apply(target, key)
      this.hardened.add(key)
    }
    return target
  }
}
