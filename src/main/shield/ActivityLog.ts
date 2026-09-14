import type { ShieldActivityEntry, ShieldCategory, ShieldCounts } from '@shared/types/shield'
import { EMPTY_COUNTS } from '@shared/types/shield'

/**
 * What Slash Shield blocked, per tab, so the dashboard can show real decisions.
 *
 * Three constraints shape this:
 *
 *  - **Hosts, never URLs.** A blocked request's path and query carry identifiers,
 *    search terms and sometimes session tokens. The host is the part that means
 *    something to a person reading the log; the rest is only risk.
 *  - **Bounded.** A tab left open on an ad-heavy site for a day would otherwise
 *    accumulate entries forever. Counts are kept exactly; the entry list is a
 *    ring buffer, so "3,412 blocked" stays true while only the recent ones are
 *    inspectable.
 *  - **In memory only.** Browsing activity is not written to disk. Closing the
 *    tab discards it; there is nothing to clear later because nothing persisted.
 *
 * Clock-injected so the ordering and trimming behaviour is testable.
 */

/** Recent entries kept per tab. Counts are unaffected by this cap. */
export const MAX_ENTRIES_PER_TAB = 100

interface TabActivity {
  counts: ShieldCounts
  entries: ShieldActivityEntry[]
}

export class ActivityLog {
  private readonly byTab = new Map<number, TabActivity>()
  private sequence = 0
  /**
   * Everything blocked since the browser started, across every tab.
   *
   * A separate counter rather than a sum over `byTab`, because per-tab records
   * are dropped when a tab goes and a running total that falls when you close a
   * tab is not a total. It is deliberately session-scoped and labelled as such
   * in the UI — an all-time figure would mean storing it, and no counter is
   * worth a migration.
   */
  private session: ShieldCounts = { ...EMPTY_COUNTS }

  /**
   * Told about each block, so a week's worth can be counted.
   *
   * A hook rather than a dependency, and it must stay cheap: this runs on the
   * request path for every blocked request on every page, so the ledger behind
   * it buffers in memory and writes on a timer. Optional, so an ActivityLog can
   * still be built without one.
   */
  private onCounted: ((category: ShieldCategory) => void) | null = null

  constructor(private readonly now: () => number = () => Date.now()) {}

  countTo(onCounted: (category: ShieldCategory) => void): void {
    this.onCounted = onCounted
  }

  /**
   * Records one blocking decision.
   *
   * Takes hosts, not URLs — the type makes the privacy rule impossible to
   * violate by accident at a call site.
   */
  record(webContentsId: number, category: ShieldCategory, host: string, pageHost: string): void {
    const activity = this.byTab.get(webContentsId) ?? {
      counts: { ...EMPTY_COUNTS },
      entries: []
    }

    activity.counts = bump(activity.counts, category)
    this.session = bump(this.session, category)
    this.onCounted?.(category)
    this.sequence += 1
    activity.entries.push({
      id: `sa-${this.sequence}`,
      at: this.now(),
      category,
      host,
      pageHost
    })

    if (activity.entries.length > MAX_ENTRIES_PER_TAB) {
      activity.entries = activity.entries.slice(-MAX_ENTRIES_PER_TAB)
    }

    this.byTab.set(webContentsId, activity)
  }

  /** Blocked since startup, across every tab this window has had. */
  sessionCounts(): ShieldCounts {
    return { ...this.session }
  }

  countsFor(webContentsId: number): ShieldCounts {
    return this.byTab.get(webContentsId)?.counts ?? { ...EMPTY_COUNTS }
  }

  /** Most recent first, which is the order the panel reads them in. */
  entriesFor(webContentsId: number, limit = 20): readonly ShieldActivityEntry[] {
    const entries = this.byTab.get(webContentsId)?.entries ?? []
    return entries.slice(-limit).reverse()
  }

  totalFor(webContentsId: number): number {
    const counts = this.countsFor(webContentsId)
    return counts.ads + counts.trackers + counts.popups + counts.redirects
  }

  /** On navigation: the new page starts from zero, as the counts describe a page. */
  reset(webContentsId: number): boolean {
    return this.byTab.delete(webContentsId)
  }

  /**
   * On tab close, and for the user's "clear protection history" action.
   *
   * Resets the session total too. Clearing is a privacy action, and a figure
   * that survived it would be a record of browsing the user just asked to
   * forget.
   */
  clearAll(): void {
    this.byTab.clear()
    this.session = { ...EMPTY_COUNTS }
  }
}

function bump(counts: ShieldCounts, category: ShieldCategory): ShieldCounts {
  switch (category) {
    case 'ad':
      return { ...counts, ads: counts.ads + 1 }
    case 'tracker':
      return { ...counts, trackers: counts.trackers + 1 }
    case 'popup':
      return { ...counts, popups: counts.popups + 1 }
    case 'redirect':
      return { ...counts, redirects: counts.redirects + 1 }
    // A refused malicious navigation is a blocked page, not a blocked resource;
    // it gets its own full-page interstitial rather than a counter increment.
    case 'malicious':
      return counts
  }
}
