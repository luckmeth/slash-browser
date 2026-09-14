import type { Recommendation, TabMetrics } from '@shared/types/performance'
import { findDuplicateGroups, duplicateCloseIds } from '@shared/tabDuplicates'
import type { Tab } from '../tabs/Tab'

/** Below this, a suggestion is not worth the interruption. */
const MIN_TABS_TO_SUGGEST = 3
const MIN_SAVINGS_BYTES = 100 * 1024 * 1024

/**
 * Turns measurements into suggestions the **user** applies.
 *
 * Nothing here acts. That separation is the point: automatic action is governed
 * by `ResourcePolicyEngine` and its guards, while this produces advice a person
 * reads and chooses to take. It exists so that `performanceMode: 'off'` still
 * gives someone a way to reclaim memory deliberately.
 *
 * Every figure it produces is an **estimate** — projected from tabs that are
 * still running — and is labelled as such wherever it appears. Only a completed
 * hibernation yields a measured number.
 */
export function buildRecommendations(
  metrics: readonly TabMetrics[],
  tabs: readonly Tab[]
): Recommendation[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]))
  const recommendations: Recommendation[] = []

  // 1. Idle tabs that nothing is blocking.
  const sleepable = metrics.filter(
    (m) => m.blockers.length === 0 && (m.state === 'IDLE' || m.state === 'FROZEN')
  )
  const estimatedSavings = sleepable.reduce((sum, m) => sum + (m.memoryBytes ?? 0), 0)

  if (sleepable.length >= MIN_TABS_TO_SUGGEST && estimatedSavings >= MIN_SAVINGS_BYTES) {
    const longestIdleMs = Math.max(...sleepable.map((m) => m.idleMs))
    recommendations.push({
      id: 'hibernate-idle',
      kind: 'hibernate-idle',
      title: `Hibernate ${sleepable.length} idle tabs`,
      detail:
        `None of them are playing audio, downloading, or holding unsaved text. ` +
        `The longest has been idle for ${formatDuration(longestIdleMs)}. ` +
        `They keep their place and their history, and reload when you return.`,
      tabIds: sleepable.map((m) => m.tabId),
      estimatedSavingsBytes: estimatedSavings
    })
  }

  /*
   * 2. Duplicates.
   *
   * `findDuplicateGroups` is the one implementation, shared with the Tab Health
   * view, so the panel and this engine cannot disagree about what counts. It
   * reaches further than the exact-address match this used to do — campaign
   * parameters, `www`, http against https, and a shared title on one host — and
   * it refuses to offer a pinned or protected copy, which this did not.
   */
  const groups = findDuplicateGroups(
    tabs.map((tab) => ({
      id: tab.id,
      url: tab.snapshot.url,
      title: tab.snapshot.title,
      lastActiveAt: tab.snapshot.lastActiveAt,
      isPinned: tab.snapshot.isPinned,
      isProtected: tab.snapshot.isProtected
    }))
  )
  const duplicates = duplicateCloseIds(groups)

  if (duplicates.length > 0) {
    const savings = duplicates.reduce((sum, id) => {
      const metric = metrics.find((m) => m.tabId === id)
      return sum + (metric?.memoryBytes ?? 0)
    }, 0)
    recommendations.push({
      id: 'close-duplicates',
      kind: 'close-duplicates',
      title: `${duplicates.length} duplicate ${duplicates.length === 1 ? 'tab' : 'tabs'}`,
      detail: `These pages are open more than once. The most recently used copy of each is kept.`,
      tabIds: duplicates,
      estimatedSavingsBytes: savings
    })
  }

  // Report why nothing can be done, rather than showing an empty panel that
  // reads as though the feature is broken.
  //
  // Only genuinely *unsafe* conditions count here. `already-hibernated`,
  // `internal-page` and `active-tab` are not reasons a tab is holding memory it
  // should not — describing an asleep tab as "unsafe to sleep" would be both
  // wrong and alarming.
  if (recommendations.length === 0) {
    const unsafe = metrics.filter((m) =>
      m.blockers.some(
        (blocker) =>
          blocker !== 'active-tab' &&
          blocker !== 'already-hibernated' &&
          blocker !== 'internal-page'
      )
    )
    const hibernated = metrics.filter((m) => m.state === 'HIBERNATED').length

    if (unsafe.length > 0) {
      recommendations.push({
        id: 'nothing-to-do',
        kind: 'hibernate-idle',
        title: 'Nothing to reclaim right now',
        detail: `${unsafe.length} background ${unsafe.length === 1 ? 'tab is' : 'tabs are'} doing something that makes sleeping ${unsafe.length === 1 ? 'it' : 'them'} unsafe — playing media, downloading, or holding text you have not submitted.`,
        tabIds: [],
        estimatedSavingsBytes: 0
      })
    } else if (hibernated > 0 && byId.size > 1) {
      recommendations.push({
        id: 'all-asleep',
        kind: 'hibernate-idle',
        title: 'Everything that can sleep is asleep',
        detail: `${hibernated} ${hibernated === 1 ? 'tab is' : 'tabs are'} hibernated. They wake when you switch to them.`,
        tabIds: [],
        estimatedSavingsBytes: 0
      })
    }
  }

  return recommendations
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}
