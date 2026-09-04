import {
  POLICY_PRESETS,
  type PerformancePolicy,
  type PerformanceState,
  type SleepBlocker
} from '@shared/types/performance'

/** Everything the policy needs to know about a tab, with no Electron types. */
export interface TabFacts {
  readonly tabId: string
  readonly isActive: boolean
  readonly isAudible: boolean
  readonly hasActiveDownload: boolean
  readonly isProtected: boolean
  readonly hasUnsavedInput: boolean
  readonly hasBeforeUnload: boolean
  readonly devToolsOpen: boolean
  readonly isInternalPage: boolean
  readonly hasLiveView: boolean
  readonly isFrozen: boolean
  readonly lastActiveAt: number
}

export interface PolicyDecision {
  readonly state: PerformanceState
  readonly blockers: readonly SleepBlocker[]
  readonly shouldFreeze: boolean
  readonly shouldHibernate: boolean
}

/**
 * Pure decision logic for what should happen to a tab.
 *
 * Deliberately free of Electron imports and of any clock of its own — `now` is a
 * parameter — so the whole state machine is directly unit-testable. That matters
 * more here than anywhere else in the codebase: the cost of a wrong decision is
 * destroying a renderer that held work the user had not saved.
 */
export class ResourcePolicyEngine {
  private policy: PerformancePolicy = POLICY_PRESETS.balanced

  getPolicy(): PerformancePolicy {
    return this.policy
  }

  setMode(mode: PerformancePolicy['mode']): void {
    this.policy = POLICY_PRESETS[mode]
  }

  /** Overrides individual thresholds while keeping the preset's identity. */
  setPolicy(patch: Partial<PerformancePolicy>): void {
    this.policy = { ...this.policy, ...patch }
  }

  /**
   * Reasons this tab must not be slept.
   *
   * Every automatic path consults this one function — nothing may freeze or
   * hibernate a tab by another route. Centralising it is what makes the guards
   * testable as a unit and what stops a future caller from quietly skipping one.
   */
  blockersFor(facts: TabFacts): SleepBlocker[] {
    const blockers: SleepBlocker[] = []

    if (facts.isInternalPage) blockers.push('internal-page')
    if (!facts.hasLiveView) blockers.push('already-hibernated')
    if (facts.isActive) blockers.push('active-tab')
    if (facts.isAudible) blockers.push('playing-audio')
    if (facts.hasActiveDownload) blockers.push('active-download')
    if (facts.isProtected) blockers.push('user-protected')
    if (facts.hasUnsavedInput) blockers.push('unsaved-form-input')
    if (facts.hasBeforeUnload) blockers.push('has-beforeunload')
    if (facts.devToolsOpen) blockers.push('devtools-open')

    return blockers
  }

  decide(facts: TabFacts, now: number): PolicyDecision {
    const blockers = this.blockersFor(facts)
    const idleMs = Math.max(0, now - facts.lastActiveAt)

    // PROTECTED is orthogonal to the ladder: it describes a user choice, not a
    // position in the recency sequence, and it outranks everything below.
    if (facts.isProtected) {
      return { state: 'PROTECTED', blockers, shouldFreeze: false, shouldHibernate: false }
    }
    if (facts.isActive) {
      return { state: 'ACTIVE', blockers, shouldFreeze: false, shouldHibernate: false }
    }
    if (!facts.hasLiveView && !facts.isInternalPage) {
      return { state: 'HIBERNATED', blockers, shouldFreeze: false, shouldHibernate: false }
    }

    // A tab doing real work is BACKGROUND regardless of how long since the user
    // looked at it — "idle" must mean idle, not merely unwatched.
    const busy = facts.isAudible || facts.hasActiveDownload
    const canSleep = blockers.length === 0 && this.policy.mode !== 'off'

    let state: PerformanceState
    if (busy) state = 'BACKGROUND'
    else if (facts.isFrozen) state = 'FROZEN'
    else if (idleMs >= this.policy.idleAfterMs) state = 'IDLE'
    else if (idleMs >= this.policy.idleAfterMs / 2) state = 'BACKGROUND'
    else state = 'RECENT'

    const shouldHibernate =
      canSleep &&
      this.policy.hibernateAfterMs > 0 &&
      idleMs >= this.policy.hibernateAfterMs

    // Freezing is skipped when the tab is already due to hibernate — going
    // FROZEN first would only add a step before the view is destroyed anyway.
    const shouldFreeze =
      canSleep && !shouldHibernate && !facts.isFrozen && idleMs >= this.policy.freezeAfterMs

    return { state, blockers, shouldFreeze, shouldHibernate }
  }
}
