import { AUTO_SNAPSHOT_INTERVAL_MS, type SnapshotTab } from '@shared/types/snapshot'
import { isInternalUrl } from '@shared/types/tab'
import type { SnapshotRepository } from '../db/repositories/SnapshotRepository'
import type { SettingsStore } from '../settings/SettingsStore'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import type { Tab } from '../tabs/Tab'
import { createLogger } from '../logger'

const log = createLogger('timemachine')

/** How many session-end snapshots to keep. Enough to recover from a bad one. */
const SESSION_END_KEEP = 5

/**
 * Records and restores browsing sessions.
 *
 * What it genuinely restores: which tabs were open, their order, pinning,
 * workspace, scroll position, and the **full back/forward list** — so the Back
 * button works after a restore rather than the tab starting from a blank
 * history.
 *
 * What it cannot restore, and the UI says so plainly: logged-in state beyond
 * whatever the cookies already carry, and anything a single-page app held only
 * in memory. A session that expired while the browser was closed will land on a
 * sign-in page, and no amount of snapshotting changes that.
 */
export class SessionSnapshotManager {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly repository: SnapshotRepository,
    private readonly settings: SettingsStore,
    private readonly windows: () => readonly BrowserWindowController[]
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.capture('automatic')
    }, AUTO_SNAPSHOT_INTERVAL_MS)
    this.prune()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Collects the current state of every window.
   *
   * Async because scroll position is read from each live renderer. A hibernated
   * tab has no renderer to ask, so its last known scroll is used instead — which
   * is exactly what was recorded when it was put to sleep.
   */
  async capture(kind: 'automatic' | 'manual' | 'session-end', label?: string): Promise<number | null> {
    const tabs: SnapshotTab[] = []
    const includePageState = this.settings.getAll().restoreFormState

    for (const window of this.windows()) {
      const ordered = window.tabs.allTabs()
      for (const [index, tab] of ordered.entries()) {
        const snap = tab.snapshot
        // An empty new tab page is not worth restoring; it is what you get
        // anyway when a window opens with nothing in it.
        if (isInternalUrl(snap.url)) continue

        tabs.push({
          url: snap.url,
          title: snap.title,
          faviconUrl: snap.faviconUrl,
          workspaceId: snap.workspaceId,
          order: index,
          isPinned: snap.isPinned,
          scrollY: await readScrollY(tab),
          entries: readEntries(tab, includePageState),
          activeEntryIndex: readActiveIndex(tab)
        })
      }
    }

    if (tabs.length === 0) return null

    const id = this.repository.create(label ?? defaultLabel(kind), kind, tabs)
    log.info(`captured ${kind} snapshot #${id} with ${tabs.length} tab(s)`)
    if (kind === 'session-end') this.repository.trimSessionEnd(SESSION_END_KEEP)
    return id
  }

  /** Snapshot written at quit, offered on the next launch. */
  latestSessionEnd(): ReturnType<SnapshotRepository['latestOfKind']> {
    return this.repository.latestOfKind('session-end')
  }

  /**
   * What startup should actually bring back: whichever is newer, the last clean
   * exit or the last automatic snapshot.
   *
   * A crash or a force-kill never writes a `session-end` — that only happens on
   * an orderly quit. Restoring from `session-end` alone therefore threw away
   * everything since the last time the browser was closed properly, which is the
   * one situation where restoring matters most. The five-minute automatic
   * snapshot was already being taken; nothing was reading it.
   *
   * Comparing timestamps rather than preferring one kind means a normal restart
   * still restores the clean exit, which is the more accurate record when it
   * exists — an automatic snapshot from four minutes before you quit would miss
   * whatever you did in those four minutes.
   */
  latestRestorable(): ReturnType<SnapshotRepository['latestOfKind']> {
    const clean = this.repository.latestOfKind('session-end')
    const automatic = this.repository.latestOfKind('automatic')
    if (!clean) return automatic
    if (!automatic) return clean
    return automatic.createdAt > clean.createdAt ? automatic : clean
  }

  prune(): void {
    const days = this.settings.getAll().snapshotRetentionDays
    if (days <= 0) return
    this.repository.pruneAutomatic(Date.now() - days * 24 * 60 * 60 * 1000)
  }
}

/**
 * Current scroll offset, read from the live page.
 *
 * Captured separately rather than relying on Chromium's `pageState`, which also
 * carries form values and is therefore not written to disk by default.
 */
async function readScrollY(tab: Tab): Promise<number> {
  const contents = tab.contents
  if (!contents || contents.isDestroyed()) return 0
  try {
    const value = (await contents.executeJavaScript('window.scrollY', true)) as unknown
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  } catch {
    // A page that blocks evaluation, or one mid-navigation, simply has no
    // scroll to record. Failing the whole snapshot over it would be worse.
    return 0
  }
}

function readEntries(
  tab: Tab,
  includePageState: boolean
): SnapshotTab['entries'] {
  const contents = tab.contents
  if (!contents || contents.isDestroyed()) return []
  try {
    return contents.navigationHistory.getAllEntries().map((entry) => ({
      url: entry.url,
      title: entry.title,
      // Stripped unless opted in: pageState holds form values as well as scroll.
      ...(includePageState && entry.pageState ? { pageState: entry.pageState } : {})
    }))
  } catch {
    return []
  }
}

function readActiveIndex(tab: Tab): number {
  const contents = tab.contents
  if (!contents || contents.isDestroyed()) return 0
  try {
    return contents.navigationHistory.getActiveIndex()
  } catch {
    return 0
  }
}

function defaultLabel(kind: 'automatic' | 'manual' | 'session-end'): string {
  const when = new Date().toLocaleString()
  if (kind === 'session-end') return `When you last closed the browser — ${when}`
  if (kind === 'manual') return `Restore point — ${when}`
  return when
}
