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
   * The private-browsing session: in memory, never written to disk.
   *
   * `session.fromPartition` **without** a `persist:` prefix gives an in-memory
   * partition — cookies, storage and cache live in the process and are gone when
   * it exits. That is what makes this genuinely private rather than a normal
   * session we promise to clean up later: there is no file to forget to delete,
   * and a crash cannot leave one behind.
   *
   * One shared partition rather than one per window, so two private windows can
   * see each other's login — which is what people expect when they open a second
   * one mid-flow. Closing every private window discards it.
   */
  getPrivate(): Session {
    return this.harden(session.fromPartition('private'), 'private')
  }

  /** Forgets the private partition, so the next one starts genuinely clean. */
  async clearPrivate(): Promise<void> {
    const target = session.fromPartition('private')
    await target.clearStorageData()
    this.hardened.delete('private')
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

  /**
   * Watches every partition for redirect status codes.
   *
   * A separate slot from the blocker for the same reason the blocker has one: a
   * session created through another path would be unobserved, and Redirect X-Ray
   * would silently show nothing for isolated workspaces.
   */
  setRedirectObserver(observer: { attachToSession: (session: Session, label: string) => void }): void {
    this.redirectObserver = observer
  }

  private blocker: { apply: (session: Session, label: string) => void } | null = null
  private redirectObserver: { attachToSession: (session: Session, label: string) => void } | null =
    null

  private harden(target: Session, key: string): Session {
    if (!this.hardened.has(key)) {
      this.hardening.apply(target, key)
      this.blocker?.apply(target, key)
      this.redirectObserver?.attachToSession(target, key)
      this.hardened.add(key)
    }
    return target
  }
}
