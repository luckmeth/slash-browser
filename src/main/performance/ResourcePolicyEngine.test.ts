import { describe, it, expect, beforeEach } from 'vitest'
import { ResourcePolicyEngine, type TabFacts } from './ResourcePolicyEngine'
import { POLICY_PRESETS } from '@shared/types/performance'

const NOW = 1_700_000_000_000
const MINUTE = 60_000

/** A plain background tab with nothing blocking it. */
function facts(overrides: Partial<TabFacts> = {}): TabFacts {
  return {
    tabId: 'tab-1',
    isActive: false,
    isAudible: false,
    hasActiveDownload: false,
    isProtected: false,
    hasUnsavedInput: false,
    hasBeforeUnload: false,
    devToolsOpen: false,
    isInternalPage: false,
    hasLiveView: true,
    isFrozen: false,
    lastActiveAt: NOW - 200 * MINUTE,
    ...overrides
  }
}

describe('ResourcePolicyEngine', () => {
  let engine: ResourcePolicyEngine

  beforeEach(() => {
    engine = new ResourcePolicyEngine()
    engine.setMode('balanced')
  })

  describe('never-hibernate guards', () => {
    // Each of these is a tab that has been idle for hours — the only thing
    // stopping it being destroyed is the guard under test.
    const cases: [string, Partial<TabFacts>][] = [
      ['the active tab', { isActive: true }],
      ['a tab playing audio', { isAudible: true }],
      ['a tab with an active download', { hasActiveDownload: true }],
      ['a user-protected tab', { isProtected: true }],
      ['a tab with unsaved form input', { hasUnsavedInput: true }],
      ['a tab with a beforeunload handler', { hasBeforeUnload: true }],
      ['a tab with devtools open', { devToolsOpen: true }],
      ['an internal page', { isInternalPage: true }],
      ['an already-hibernated tab', { hasLiveView: false }]
    ]

    for (const [label, override] of cases) {
      it(`never hibernates ${label}`, () => {
        const decision = engine.decide(facts(override), NOW)
        expect(decision.shouldHibernate).toBe(false)
        expect(decision.shouldFreeze).toBe(false)
        expect(decision.blockers.length).toBeGreaterThan(0)
      })
    }

    it('reports every applicable blocker, not just the first', () => {
      const decision = engine.decide(
        facts({ isAudible: true, hasUnsavedInput: true, isProtected: true }),
        NOW
      )
      expect(decision.blockers).toContain('playing-audio')
      expect(decision.blockers).toContain('unsaved-form-input')
      expect(decision.blockers).toContain('user-protected')
    })
  })

  describe('state ladder', () => {
    it('marks the active tab ACTIVE regardless of idle time', () => {
      expect(engine.decide(facts({ isActive: true }), NOW).state).toBe('ACTIVE')
    })

    it('marks a protected tab PROTECTED, outranking the ladder', () => {
      expect(engine.decide(facts({ isProtected: true }), NOW).state).toBe('PROTECTED')
    })

    it('marks a freshly used tab RECENT', () => {
      expect(engine.decide(facts({ lastActiveAt: NOW - 30_000 }), NOW).state).toBe('RECENT')
    })

    it('marks an idle tab IDLE once past the threshold', () => {
      const { idleAfterMs } = POLICY_PRESETS.balanced
      expect(engine.decide(facts({ lastActiveAt: NOW - idleAfterMs }), NOW).state).toBe('IDLE')
    })

    it('keeps a tab doing work BACKGROUND however long since it was viewed', () => {
      // "Idle" must mean idle, not merely unwatched.
      const decision = engine.decide(
        facts({ isAudible: true, lastActiveAt: NOW - 500 * MINUTE }),
        NOW
      )
      expect(decision.state).toBe('BACKGROUND')
    })

    it('reports a tab with no view as HIBERNATED', () => {
      expect(engine.decide(facts({ hasLiveView: false }), NOW).state).toBe('HIBERNATED')
    })
  })

  describe('automatic actions', () => {
    it('hibernates an unblocked tab past the hibernate threshold', () => {
      const { hibernateAfterMs } = POLICY_PRESETS.balanced
      const decision = engine.decide(facts({ lastActiveAt: NOW - hibernateAfterMs }), NOW)
      expect(decision.shouldHibernate).toBe(true)
    })

    it('freezes between the freeze and hibernate thresholds', () => {
      const { freezeAfterMs } = POLICY_PRESETS.balanced
      const decision = engine.decide(facts({ lastActiveAt: NOW - freezeAfterMs }), NOW)
      expect(decision.shouldFreeze).toBe(true)
      expect(decision.shouldHibernate).toBe(false)
    })

    it('skips freezing when the tab is already due to hibernate', () => {
      // Going FROZEN first would only add a step before the view is destroyed.
      const decision = engine.decide(facts({ lastActiveAt: NOW - 500 * MINUTE }), NOW)
      expect(decision.shouldHibernate).toBe(true)
      expect(decision.shouldFreeze).toBe(false)
    })

    it('does not re-freeze an already frozen tab', () => {
      const { freezeAfterMs } = POLICY_PRESETS.balanced
      const decision = engine.decide(
        facts({ isFrozen: true, lastActiveAt: NOW - freezeAfterMs }),
        NOW
      )
      expect(decision.shouldFreeze).toBe(false)
    })

    it('takes no automatic action at all in "off" mode', () => {
      engine.setMode('off')
      const decision = engine.decide(facts({ lastActiveAt: NOW - 1000 * MINUTE }), NOW)
      expect(decision.shouldFreeze).toBe(false)
      expect(decision.shouldHibernate).toBe(false)
      // Still classified, so the dashboard can recommend manual action.
      expect(decision.state).toBe('IDLE')
    })

    it('acts sooner in aggressive mode than balanced', () => {
      const idleFor = 40 * MINUTE
      engine.setMode('balanced')
      expect(engine.decide(facts({ lastActiveAt: NOW - idleFor }), NOW).shouldHibernate).toBe(false)

      engine.setMode('aggressive')
      expect(engine.decide(facts({ lastActiveAt: NOW - idleFor }), NOW).shouldHibernate).toBe(true)
    })

    it('honours a custom threshold override', () => {
      engine.setPolicy({ hibernateAfterMs: MINUTE })
      expect(engine.decide(facts({ lastActiveAt: NOW - 2 * MINUTE }), NOW).shouldHibernate).toBe(
        true
      )
    })

    it('treats hibernateAfterMs of 0 as automatic hibernation disabled', () => {
      engine.setPolicy({ hibernateAfterMs: 0 })
      expect(
        engine.decide(facts({ lastActiveAt: NOW - 10_000 * MINUTE }), NOW).shouldHibernate
      ).toBe(false)
    })
  })

  it('never produces a negative idle time when the clock moves backwards', () => {
    // System clock changes and suspend/resume can make lastActiveAt appear in
    // the future; that must not read as "infinitely idle".
    const decision = engine.decide(facts({ lastActiveAt: NOW + 5 * MINUTE }), NOW)
    expect(decision.shouldHibernate).toBe(false)
    expect(decision.state).toBe('RECENT')
  })
})
