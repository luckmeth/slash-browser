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
  /**
   * Which partition each session came from.
   *
   * Electron hands out `Session` objects and never says which partition string
   * produced one, so a download that needs to be picked up after a restart has
   * no way to ask for the same cookie jar again. This is the only place that
   * mapping exists, because this is the only place partitions are created.
   */
  private readonly labels = new WeakMap<Session, string>()

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

  /**
   * Watches every partition for media a page is streaming.
   *
   * Same reasoning as the two slots above: a workspace with its own partition is
   * still a place somebody watches video, and one created through another path
   * would silently offer nothing to download.
   */
  setMediaSniffer(sniffer: { install: (session: Session, label: string) => void }): void {
    this.mediaSniffer = sniffer
  }

  private blocker: { apply: (session: Session, label: string) => void } | null = null
  private redirectObserver: { attachToSession: (session: Session, label: string) => void } | null =
    null
  private mediaSniffer: { install: (session: Session, label: string) => void } | null = null

  /**
   * The partition a session came from, for anything that must ask again later.
   *
   * Null for a session this registry did not create — there is no honest name
   * to give it, and inventing one would send a download's cookies to the wrong
   * jar.
   */
  partitionOf(target: Session): string | null {
    return this.labels.get(target) ?? null
  }

  /**
   * The session a partition name refers to, or null.
   *
   * `private` is refused on purpose. An in-memory partition is gone once its
   * windows close, so a name pointing at one describes something that no longer
   * exists — and resurrecting it for a download the user made privately is the
   * opposite of what a private window promises.
   */
  fromPartition(label: string): Session | null {
    if (label === 'private') return null
    if (label === 'default') return this.getDefault()
    if (!label.startsWith('persist:')) return null
    return this.harden(session.fromPartition(label), label)
  }

  private harden(target: Session, key: string): Session {
    this.labels.set(target, key)
    if (!this.hardened.has(key)) {
      this.hardening.apply(target, key)
      this.blocker?.apply(target, key)
      this.redirectObserver?.attachToSession(target, key)
      this.mediaSniffer?.install(target, key)
      this.hardened.add(key)
    }
    return target
  }
}
