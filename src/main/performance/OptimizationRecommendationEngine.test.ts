import { describe, it, expect } from 'vitest'
import { buildRecommendations } from './OptimizationRecommendationEngine'
import type { TabMetrics } from '@shared/types/performance'
import { Tab } from '../tabs/Tab'

const MB = 1024 * 1024

function metric(overrides: Partial<TabMetrics> & { tabId: string }): TabMetrics {
  return {
    state: 'IDLE',
    processId: 100,
    sharedProcess: false,
    tabsOnProcess: 1,
    cpuPercent: 0,
    memoryBytes: 80 * MB,
    idleMs: 30 * 60_000,
    blockers: [],
    measuredSavingsBytes: null,
    ...overrides
  }
}

function tab(url: string, lastActiveAt = Date.now()): Tab {
  const created = new Tab({ workspaceId: 'default', url })
  created.patch({ lastActiveAt })
  return created
}

describe('buildRecommendations', () => {
  it('suggests hibernating several unblocked idle tabs', () => {
    const metrics = [metric({ tabId: 'a' }), metric({ tabId: 'b' }), metric({ tabId: 'c' })]
    const tabs = [tab('https://a.com'), tab('https://b.com'), tab('https://c.com')]

    const [first] = buildRecommendations(metrics, tabs)
    expect(first?.kind).toBe('hibernate-idle')
    expect(first?.tabIds).toHaveLength(3)
    expect(first?.estimatedSavingsBytes).toBe(240 * MB)
  })

  it('stays quiet below the tab or savings floor', () => {
    // Two tabs is not worth an interruption.
    expect(buildRecommendations([metric({ tabId: 'a' }), metric({ tabId: 'b' })], [])).toEqual([])

    // Nor is a large number of tiny tabs.
    const tiny = ['a', 'b', 'c', 'd'].map((tabId) => metric({ tabId, memoryBytes: 1 * MB }))
    expect(buildRecommendations(tiny, []).some((r) => r.kind === 'hibernate-idle')).toBe(false)
  })

  it('never suggests a blocked tab', () => {
    const metrics = [
      metric({ tabId: 'a', blockers: ['playing-audio'] }),
      metric({ tabId: 'b', blockers: ['unsaved-form-input'] }),
      metric({ tabId: 'c', blockers: ['user-protected'] })
    ]
    expect(buildRecommendations(metrics, []).some((r) => r.tabIds.length > 0)).toBe(false)
  })

  it('offers duplicates, keeping the most recently used copy', () => {
    const older = tab('https://example.com/docs', 1000)
    const newer = tab('https://example.com/docs', 5000)
    const metrics = [metric({ tabId: older.id }), metric({ tabId: newer.id })]

    const duplicates = buildRecommendations(metrics, [older, newer]).find(
      (r) => r.kind === 'close-duplicates'
    )
    expect(duplicates?.tabIds).toEqual([older.id])
  })

  it('treats urls differing only by hash or trailing slash as duplicates', () => {
    const a = tab('https://example.com/docs', 1000)
    const b = tab('https://example.com/docs/#intro', 5000)
    const metrics = [metric({ tabId: a.id }), metric({ tabId: b.id })]

    const duplicates = buildRecommendations(metrics, [a, b]).find(
      (r) => r.kind === 'close-duplicates'
    )
    expect(duplicates?.tabIds).toEqual([a.id])
  })

  it('does not describe already-hibernated tabs as unsafe to sleep', () => {
    // Regression: the fallback message counted `already-hibernated` as a reason
    // a tab was holding memory, telling the user three sleeping tabs were
    // "doing something that makes sleeping them unsafe".
    const metrics = [
      metric({ tabId: 'active', state: 'ACTIVE', blockers: ['active-tab'] }),
      metric({ tabId: 'a', state: 'HIBERNATED', blockers: ['already-hibernated'] }),
      metric({ tabId: 'b', state: 'HIBERNATED', blockers: ['already-hibernated'] })
    ]

    const [only] = buildRecommendations(metrics, [tab('https://a.com'), tab('https://b.com')])
    expect(only?.id).toBe('all-asleep')
    expect(only?.detail).toContain('2 tabs are hibernated')
  })

  it('reports genuinely unsafe tabs when there is nothing to reclaim', () => {
    const metrics = [
      metric({ tabId: 'active', state: 'ACTIVE', blockers: ['active-tab'] }),
      metric({ tabId: 'a', blockers: ['playing-audio'] }),
      metric({ tabId: 'b', blockers: ['unsaved-form-input'] })
    ]

    const [only] = buildRecommendations(metrics, [tab('https://a.com'), tab('https://b.com')])
    expect(only?.id).toBe('nothing-to-do')
    expect(only?.detail).toContain('2 background tabs are')
  })
})
