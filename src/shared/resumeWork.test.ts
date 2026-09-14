import { describe, it, expect } from 'vitest'
import {
  resumeCards,
  agoPhrase,
  RESUME_WINDOW_MS,
  RESUME_LIMIT,
  type ResumeInput,
  type ResumeSnapshot,
  type ResumeWorkspace,
  type ResumeTab
} from './resumeWork'

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const snapshot = (over: Partial<ResumeSnapshot> = {}): ResumeSnapshot => ({
  id: 1,
  label: 'Restore point',
  kind: 'manual',
  createdAt: NOW - HOUR,
  tabCount: 5,
  workspaceCount: 1,
  ...over
})

const workspace = (over: Partial<ResumeWorkspace> = {}): ResumeWorkspace => ({
  id: 'default',
  name: 'Personal',
  icon: 'wsHome',
  isolated: false,
  ...over
})

const tab = (over: Partial<ResumeTab> = {}): ResumeTab => ({
  workspaceId: 'default',
  lastActiveAt: NOW - HOUR,
  isInternal: false,
  ...over
})

const input = (over: Partial<ResumeInput> = {}): ResumeInput => ({
  snapshots: [],
  workspaces: [],
  tabs: [],
  activeWorkspaceId: 'default',
  now: NOW,
  ...over
})

describe('resumeCards', () => {
  it('offers nothing on a browser with no history', () => {
    expect(resumeCards(input())).toEqual([])
  })

  it('leads with the last session', () => {
    // The one card that answers "I closed the browser and want my tabs back",
    // which is what most people mean by resuming.
    const cards = resumeCards(
      input({
        snapshots: [
          snapshot({ id: 2, kind: 'manual', label: 'Reading', createdAt: NOW - 60_000 }),
          snapshot({ id: 1, kind: 'session-end', createdAt: NOW - 2 * HOUR })
        ],
        workspaces: [workspace()],
        tabs: [tab()]
      })
    )
    expect(cards[0]?.kind).toBe('session')
    expect(cards[0]?.title).toBe('When you last closed the browser')
  })

  it('counts workspaces only when there was more than one', () => {
    const one = resumeCards(
      input({ snapshots: [snapshot({ kind: 'session-end', tabCount: 5, workspaceCount: 1 })] })
    )
    const many = resumeCards(
      input({ snapshots: [snapshot({ kind: 'session-end', tabCount: 9, workspaceCount: 3 })] })
    )
    expect(one[0]?.detail).toBe('5 tabs')
    expect(many[0]?.detail).toBe('9 tabs across 3 workspaces')
  })

  it('says "1 tab", not "1 tabs"', () => {
    const cards = resumeCards(
      input({ snapshots: [snapshot({ kind: 'session-end', tabCount: 1 })] })
    )
    expect(cards[0]?.detail).toBe('1 tab')
  })

  it('ignores an empty restore point', () => {
    // A snapshot of nothing restores nothing, and a card offering that is worse
    // than no card.
    const cards = resumeCards(
      input({ snapshots: [snapshot({ kind: 'session-end', tabCount: 0 })] })
    )
    expect(cards).toEqual([])
  })

  it('forgets restore points older than the window', () => {
    const cards = resumeCards(
      input({
        snapshots: [
          snapshot({ id: 1, createdAt: NOW - RESUME_WINDOW_MS - 1 }),
          snapshot({ id: 2, createdAt: NOW - RESUME_WINDOW_MS + HOUR })
        ]
      })
    )
    expect(cards.map((c) => c.target)).toEqual([2])
  })

  it('offers a workspace that has real tabs open in it', () => {
    const cards = resumeCards(
      input({
        workspaces: [workspace({ id: 'work', name: 'Work' })],
        tabs: [tab({ workspaceId: 'work' }), tab({ workspaceId: 'work' })]
      })
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ kind: 'workspace', title: 'Work', detail: '2 tabs open' })
  })

  it('does not offer a workspace holding only internal pages', () => {
    // A window of new tab pages is not work, and offering it as something to
    // resume is the difference between a useful card and a list of everything.
    const cards = resumeCards(
      input({
        workspaces: [workspace({ id: 'empty', name: 'Empty' })],
        tabs: [tab({ workspaceId: 'empty', isInternal: true })]
      })
    )
    expect(cards).toEqual([])
  })

  it('does not offer a workspace with no tabs at all', () => {
    const cards = resumeCards(input({ workspaces: [workspace({ id: 'unused' })] }))
    expect(cards).toEqual([])
  })

  it('orders workspaces by when they were last touched', () => {
    const cards = resumeCards(
      input({
        workspaces: [
          workspace({ id: 'old', name: 'Old' }),
          workspace({ id: 'new', name: 'New' })
        ],
        tabs: [
          tab({ workspaceId: 'old', lastActiveAt: NOW - 5 * HOUR }),
          tab({ workspaceId: 'new', lastActiveAt: NOW - 60_000 })
        ]
      })
    )
    expect(cards.map((c) => c.title)).toEqual(['New', 'Old'])
  })

  it('takes a workspace time from its most recent tab', () => {
    const cards = resumeCards(
      input({
        workspaces: [workspace({ id: 'w', name: 'W' })],
        tabs: [
          tab({ workspaceId: 'w', lastActiveAt: NOW - 9 * HOUR }),
          tab({ workspaceId: 'w', lastActiveAt: NOW - HOUR })
        ]
      })
    )
    expect(cards[0]?.at).toBe(NOW - HOUR)
  })

  it('marks the workspace the user is already in', () => {
    const cards = resumeCards(
      input({
        workspaces: [workspace({ id: 'here', name: 'Here' })],
        tabs: [tab({ workspaceId: 'here' })],
        activeWorkspaceId: 'here'
      })
    )
    expect(cards[0]?.current).toBe(true)
  })

  it('never offers an automatic snapshot', () => {
    // One every five minutes, all called the same thing. A resume list made of
    // those is a list of moments rather than of work.
    const cards = resumeCards(
      input({ snapshots: [snapshot({ kind: 'automatic', label: 'Automatic' })] })
    )
    expect(cards).toEqual([])
  })

  it('offers named restore points, newest first', () => {
    const cards = resumeCards(
      input({
        snapshots: [
          snapshot({ id: 1, label: 'Older', createdAt: NOW - 3 * DAY }),
          snapshot({ id: 2, label: 'Newer', createdAt: NOW - DAY })
        ]
      })
    )
    expect(cards.map((c) => c.title)).toEqual(['Newer', 'Older'])
  })

  it('caps the list so the page does not become one', () => {
    const cards = resumeCards(
      input({
        snapshots: Array.from({ length: 10 }, (_, i) =>
          snapshot({ id: i, label: `Point ${i}`, createdAt: NOW - i * HOUR })
        )
      })
    )
    expect(cards).toHaveLength(RESUME_LIMIT)
  })

  it('gives every card a distinct id', () => {
    // The kinds share a number space — snapshot 1 and workspace "1" — so the
    // prefix is what stops React reusing one card's state for another's.
    const cards = resumeCards(
      input({
        snapshots: [snapshot({ id: 1, kind: 'session-end' }), snapshot({ id: 2 })],
        workspaces: [workspace({ id: '1' })],
        tabs: [tab({ workspaceId: '1' })]
      })
    )
    expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length)
  })
})

describe('agoPhrase', () => {
  it.each([
    [0, 'just now'],
    [30_000, 'just now'],
    [60_000, '1 minute ago'],
    [5 * 60_000, '5 minutes ago'],
    [HOUR, '1 hour ago'],
    [5 * HOUR, '5 hours ago'],
    [DAY, 'yesterday'],
    [3 * DAY, '3 days ago'],
    [8 * DAY, '1 week ago'],
    [20 * DAY, '2 weeks ago']
  ])('reads %i ms ago as "%s"', (ms, expected) => {
    expect(agoPhrase(NOW - ms, NOW)).toBe(expected)
  })

  it('does not report the future as a negative age', () => {
    // A clock that moved backwards is not an error worth showing somebody.
    expect(agoPhrase(NOW + HOUR, NOW)).toBe('just now')
  })
})
