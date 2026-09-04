import { isInternalUrl } from '@shared/types/tab'
import type { PerformanceSnapshot, TabMetrics } from '@shared/types/performance'
import type { TabManager } from '../tabs/TabManager'
import type { Tab } from '../tabs/Tab'
import { createLogger } from '../logger'
import { ResourceSampler } from './ResourceSampler'
import { ResourcePolicyEngine, type TabFacts } from './ResourcePolicyEngine'
import { buildRecommendations } from './OptimizationRecommendationEngine'

const log = createLogger('perf')

/** How often to sample. Cheap, but not free — this is a background diagnostic. */
const SAMPLE_INTERVAL_MS = 5000
/** Backed off to this when no tab has been interacted with for a while. */
const IDLE_SAMPLE_INTERVAL_MS = 20_000
const IDLE_BACKOFF_AFTER_MS = 120_000

export interface PerformanceHooks {
  onSnapshot: (snapshot: PerformanceSnapshot) => void
  /** Whether a download is currently running in this tab. */
  hasActiveDownload: (tabId: string) => boolean
}

/**
 * Drives the tab lifecycle: samples usage, asks the policy what should happen,
 * and carries it out.
 *
 * All the judgement lives in `ResourcePolicyEngine`, which is pure and directly
 * tested. This class is the part that touches Electron, and it deliberately does
 * no reasoning of its own — it never decides to sleep a tab, it only executes a
 * decision that already passed the guards.
 */
export class TabPerformanceManager {
  private readonly sampler = new ResourceSampler()
  readonly policy = new ResourcePolicyEngine()
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastInteractionAt = Date.now()

  constructor(
    private readonly tabs: TabManager,
    private readonly hooks: PerformanceHooks
  ) {}

  start(): void {
    if (this.timer) return
    this.schedule()
    log.info('monitoring started')
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Called on user activity so sampling can back off when the app is untouched. */
  noteInteraction(): void {
    this.lastInteractionAt = Date.now()
  }

  private schedule(): void {
    const quiet = Date.now() - this.lastInteractionAt > IDLE_BACKOFF_AFTER_MS
    this.timer = setTimeout(
      () => {
        this.tick()
        this.schedule()
      },
      quiet ? IDLE_SAMPLE_INTERVAL_MS : SAMPLE_INTERVAL_MS
    )
  }

  private tick(): void {
    const snapshot = this.evaluate(true)
    this.hooks.onSnapshot(snapshot)
  }

  /** Recomputes without acting — used by the dashboard on demand. */
  snapshot(): PerformanceSnapshot {
    return this.evaluate(false)
  }

  private factsFor(tab: Tab, activeId: string | null): TabFacts {
    const snap = tab.snapshot
    return {
      tabId: tab.id,
      isActive: tab.id === activeId,
      isAudible: snap.isAudible,
      hasActiveDownload: this.hooks.hasActiveDownload(tab.id),
      isProtected: snap.isProtected,
      hasUnsavedInput: tab.hasUnsavedInput,
      hasBeforeUnload: tab.hasBeforeUnload,
      devToolsOpen: tab.contents?.isDevToolsOpened() ?? false,
      isInternalPage: isInternalUrl(snap.url),
      hasLiveView: tab.view !== null,
      isFrozen: snap.isFrozen,
      lastActiveAt: snap.lastActiveAt
    }
  }

  private evaluate(applyActions: boolean): PerformanceSnapshot {
    const all = this.tabs.allTabs()
    const activeId = this.tabs.activeId
    const now = Date.now()

    // One pid per *tab*, duplicates included — the repetition is what reveals
    // that a process is shared and its numbers can only be an estimate.
    const pids = all
      .map((tab) => tab.contents?.getOSProcessId() ?? null)
      .filter((pid): pid is number => typeof pid === 'number' && pid > 0)

    const sample = this.sampler.sample(pids)

    const metrics: TabMetrics[] = []
    const toFreeze: string[] = []
    const toHibernate: Array<{ id: string; rss: number | null }> = []

    for (const tab of all) {
      const facts = this.factsFor(tab, activeId)
      const decision = this.policy.decide(facts, now)
      const pid = tab.contents?.getOSProcessId() ?? null
      const attribution = this.sampler.attribute(pid)

      metrics.push({
        tabId: tab.id,
        state: decision.state,
        processId: pid,
        sharedProcess: attribution.shared,
        tabsOnProcess: attribution.tabsOnProcess,
        cpuPercent: attribution.cpuPercent,
        memoryBytes: attribution.memoryBytes,
        idleMs: Math.max(0, now - facts.lastActiveAt),
        blockers: [...decision.blockers],
        measuredSavingsBytes: tab.measuredSavingsBytes
      })

      if (!applyActions) continue
      if (decision.shouldHibernate) {
        // Whole-process figure, not the divided estimate: this is what will
        // actually be freed, and only if the process is not shared.
        toHibernate.push({
          id: tab.id,
          rss: attribution.shared ? null : this.sampler.processMemoryBytes(pid)
        })
      } else if (decision.shouldFreeze) {
        toFreeze.push(tab.id)
      }
    }

    // Mutating tabs while iterating them would invalidate the loop, so actions
    // are collected first and applied after.
    for (const id of toFreeze) this.tabs.freeze(id)
    for (const { id, rss } of toHibernate) this.tabs.hibernate(id, rss)

    const totalMeasuredSavingsBytes = all.reduce(
      (sum, tab) => sum + (tab.measuredSavingsBytes ?? 0),
      0
    )

    return {
      tabs: metrics,
      recommendations: buildRecommendations(metrics, all),
      totalMeasuredSavingsBytes,
      metricsAvailable: sample.available,
      sampledAt: sample.sampledAt
    }
  }

  // --- manual operations, invoked from the dashboard ------------------------

  /**
   * Hibernates on the user's explicit request.
   *
   * Still runs the guards. A user pressing a button is not a reason to silently
   * destroy a form they were half way through filling in — the caller gets
   * `false` and the UI explains which blocker applied.
   */
  hibernateManually(tabId: string): boolean {
    const tab = this.tabs.findById(tabId)
    if (!tab) return false
    const facts = this.factsFor(tab, this.tabs.activeId)
    if (this.policy.blockersFor(facts).length > 0) return false

    const pid = tab.contents?.getOSProcessId() ?? null
    const shared = this.sampler.attribute(pid).shared
    return this.tabs.hibernate(tabId, shared ? null : this.sampler.processMemoryBytes(pid))
  }

  freezeManually(tabId: string): boolean {
    const tab = this.tabs.findById(tabId)
    if (!tab) return false
    if (this.policy.blockersFor(this.factsFor(tab, this.tabs.activeId)).length > 0) return false
    this.tabs.freeze(tabId)
    return true
  }

  applyRecommendation(tabIds: readonly string[]): number {
    let applied = 0
    for (const id of tabIds) if (this.hibernateManually(id)) applied += 1
    return applied
  }
}
