/**
 * Tab Health: how many tabs there are, and what could honestly be done about it.
 *
 * The number that makes this feature tempting to fake is the memory one. Every
 * browser that shows "~1.2 GB could be freed" is projecting from processes that
 * are still running, and CLAUDE.md is unambiguous about what that means here:
 * `app.getAppMetrics()` is per **process**, site isolation shares renderers, and
 * only a completed hibernation yields a figure anybody measured.
 *
 * So this reports two separate totals and never adds them together:
 *
 *   - `measuredFreedBytes` — bytes actually released, recorded immediately
 *     before each renderer was destroyed. A fact.
 *   - `estimatedOpportunityBytes` — what the tabs that could sleep are using
 *     now. A projection, and labelled as one everywhere it appears.
 *
 * Pure and tested, because the difference between those two is the whole of the
 * project's honesty on this subject.
 */

export type HealthState = 'ACTIVE' | 'IDLE' | 'FROZEN' | 'HIBERNATED'

export interface HealthTab {
  readonly tabId: string
  readonly state: HealthState
  /** Working set now, or null where it could not be measured. */
  readonly memoryBytes: number | null
  /** Bytes freed when this tab was hibernated. Null if it never was. */
  readonly measuredSavingsBytes: number | null
  /** Anything at all in here means the tab must not be slept. */
  readonly blockers: readonly string[]
  /** True when this tab's figure is a process total divided between tabs. */
  readonly sharedProcess: boolean
}

export interface TabHealth {
  readonly total: number
  readonly active: number
  readonly idle: number
  readonly asleep: number
  /** Tabs nothing is stopping from sleeping. What "Hibernate safe tabs" acts on. */
  readonly sleepableIds: readonly string[]
  /** Tabs held awake by something, with the reason left to the caller to name. */
  readonly blockedCount: number
  readonly duplicateCount: number
  /** Measured. Bytes genuinely released by hibernations this session. */
  readonly measuredFreedBytes: number
  /** Estimated. What the sleepable tabs are using right now. */
  readonly estimatedOpportunityBytes: number
  /**
   * Whether any figure above rests on a divided process total.
   *
   * When true the UI must say "estimate" even about the per-tab numbers, because
   * a shared renderer's memory is not attributable to one of the tabs in it.
   */
  readonly hasSharedProcesses: boolean
  /** False when Chromium reported nothing usable this cycle. */
  readonly memoryMeasurable: boolean
}

/**
 * Blockers that are not a *problem*.
 *
 * A hibernated tab is not "unsafe to sleep", it is already asleep; an internal
 * page has no renderer to free; the tab you are looking at is supposed to be
 * awake. Counting these as blocked would report a healthy browser as one full of
 * tabs something is wrong with.
 */
const UNREMARKABLE_BLOCKERS = new Set(['active-tab', 'already-hibernated', 'internal-page'])

export function summariseTabHealth(
  tabs: readonly HealthTab[],
  duplicateCount: number
): TabHealth {
  let active = 0
  let idle = 0
  let asleep = 0
  let blockedCount = 0
  let measuredFreedBytes = 0
  let estimatedOpportunityBytes = 0
  let hasSharedProcesses = false
  let anyMemory = false

  const sleepableIds: string[] = []

  for (const tab of tabs) {
    if (tab.state === 'ACTIVE') active += 1
    else if (tab.state === 'IDLE') idle += 1
    else asleep += 1

    if (tab.sharedProcess) hasSharedProcesses = true
    if (tab.memoryBytes !== null) anyMemory = true
    if (tab.measuredSavingsBytes !== null) measuredFreedBytes += tab.measuredSavingsBytes

    const remarkable = tab.blockers.filter((blocker) => !UNREMARKABLE_BLOCKERS.has(blocker))
    if (remarkable.length > 0) {
      blockedCount += 1
      continue
    }

    // Only a tab that is both idle-or-frozen and unblocked is offerable. An
    // active tab has nothing wrong with it, and a hibernated one has already
    // given back what it had.
    if (tab.state === 'IDLE' || tab.state === 'FROZEN') {
      if (tab.blockers.length === 0) {
        sleepableIds.push(tab.tabId)
        estimatedOpportunityBytes += tab.memoryBytes ?? 0
      }
    }
  }

  return {
    total: tabs.length,
    active,
    idle,
    asleep,
    sleepableIds,
    blockedCount,
    duplicateCount,
    measuredFreedBytes,
    estimatedOpportunityBytes,
    hasSharedProcesses,
    memoryMeasurable: anyMemory
  }
}

/**
 * Bytes, in the units people read.
 *
 * Rounded to one decimal above a megabyte, because a browser reporting
 * "1,283,491,328 bytes" is showing a number rather than telling somebody
 * anything.
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return '<1 MB'
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/**
 * The sentence under the memory figure.
 *
 * Two different claims, and they must never be merged into one number. The
 * shared-process caveat is added when it applies, because a renderer serving
 * three tabs cannot have its memory attributed to one of them.
 */
export function memoryCaption(health: TabHealth): string {
  if (!health.memoryMeasurable) {
    return 'Memory could not be measured this cycle.'
  }

  const parts: string[] = []
  if (health.estimatedOpportunityBytes > 0) {
    parts.push(
      `About ${formatBytes(health.estimatedOpportunityBytes)} is held by tabs that could sleep — ` +
        `an estimate, projected from processes that are still running.`
    )
  }
  if (health.measuredFreedBytes > 0) {
    parts.push(
      `${formatBytes(health.measuredFreedBytes)} has actually been released, ` +
        `measured immediately before each tab was hibernated.`
    )
  }
  if (parts.length === 0) {
    /*
     * "Nothing could be freed" is wrong while duplicates are on offer, and the
     * two sat next to each other: this line said nothing was available, while
     * the suggestion below it offered 144 MB from closing duplicate tabs. They
     * are different claims — sleeping an idle tab and closing a second copy of
     * a page — but a reader is entitled to treat one panel as one answer.
     */
    return health.duplicateCount > 0
      ? 'No tab is idle enough to sleep yet. Closing duplicates is the memory on offer here.'
      : 'Nothing is currently holding memory that could be freed.'
  }

  if (health.hasSharedProcesses) {
    parts.push('Some tabs share a renderer, so their individual figures are divided estimates.')
  }
  return parts.join(' ')
}
