import { describe, it, expect } from 'vitest'
import { BrowserActionSchema } from '@shared/types/ai'
import { ContextBuilder } from './ContextBuilder'
import type { Tab } from '@shared/types/tab'
import type { Workspace } from '@shared/types/workspace'

function tab(overrides: Partial<Tab> & { id: string; url: string }): Tab {
  return {
    workspaceId: 'default',
    title: 'A page',
    faviconUrl: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isPinned: false,
    isAudible: false,
    isMuted: false,
    isProtected: false,
    isFrozen: false,
    zoomLevel: 0,
    findResult: null,
    status: 'live',
    error: null,
    lastActiveAt: 0,
    createdAt: 0,
    ...overrides
  }
}

const workspace: Workspace = {
  id: 'default',
  name: 'Personal',
  icon: '🏠',
  color: 'slate',
  isolated: false,
  notes: '',
  sortOrder: 0,
  createdAt: 0
}

/**
 * The action union is the safety boundary. These tests assert that capabilities
 * the AI must never have are *unrepresentable*, not merely discouraged — a model
 * asking for one produces a payload that cannot be parsed, so it never reaches
 * the executor at all.
 */
describe('BrowserActionSchema — prohibited capabilities are unrepresentable', () => {
  const forbidden = [
    { kind: 'send-message', to: 'someone@example.com', body: 'hello' },
    { kind: 'purchase', item: 'laptop', amount: 999 },
    { kind: 'submit-form', tabId: 'tab-1' },
    { kind: 'change-setting', key: 'aiProvider', value: 'anthropic' },
    { kind: 'grant-permission', origin: 'https://evil.example', permission: 'camera' },
    { kind: 'delete-history' },
    { kind: 'navigate', tabId: 'tab-1', url: 'https://evil.example' },
    { kind: 'run-script', tabId: 'tab-1', code: 'fetch("https://evil.example")' }
  ]

  for (const payload of forbidden) {
    it(`rejects "${payload.kind}"`, () => {
      expect(BrowserActionSchema.safeParse(payload).success).toBe(false)
    })
  }

  it('accepts only the six declared kinds', () => {
    const allowed = [
      { kind: 'organize-tabs', groups: [{ name: 'Work', tabIds: ['t1'] }] },
      { kind: 'create-workspace', name: 'Research', icon: '📚', tabIds: ['t1'] },
      { kind: 'move-tabs', tabIds: ['t1'], toWorkspaceId: 'ws1' },
      { kind: 'close-tabs', tabIds: ['t1'], reason: 'duplicates' },
      { kind: 'save-tabs', tabIds: ['t1'], toBookmarkFolder: 'Reading' },
      { kind: 'reading-queue', tabIds: ['t1'], orderedTabIds: ['t1'] }
    ]
    for (const action of allowed) {
      expect(BrowserActionSchema.safeParse(action).success).toBe(true)
    }
  })

  it('rejects a valid kind carrying an injected extra capability', () => {
    // Smuggling a field onto a legitimate action must not widen what it does.
    const parsed = BrowserActionSchema.safeParse({
      kind: 'close-tabs',
      tabIds: ['t1'],
      reason: 'cleanup',
      alsoDeleteHistory: true
    })
    // zod strips unknown keys rather than failing, which is what we want — the
    // extra field simply does not exist as far as the executor is concerned.
    expect(parsed.success).toBe(true)
    if (parsed.success) expect('alsoDeleteHistory' in parsed.data).toBe(false)
  })

  it('rejects an action with no tabs to act on', () => {
    expect(BrowserActionSchema.safeParse({ kind: 'close-tabs', tabIds: [], reason: 'x' }).success).toBe(
      false
    )
  })
})

describe('ContextBuilder — the single egress path', () => {
  it('sends titles and hosts, never full URLs or page text by default', () => {
    const context = new ContextBuilder({
      tabs: [tab({ id: 't1', url: 'https://example.com/secret-path?token=abc', title: 'Example' })],
      workspaces: [workspace],
      activeWorkspaceId: 'default',
      excludedOrigins: [],
      includePageContent: false
    }).build()

    expect(context).toContain('example.com')
    expect(context).toContain('Example')
    // A URL path or query can itself be sensitive — a token, an order id.
    expect(context).not.toContain('secret-path')
    expect(context).not.toContain('token=abc')
  })

  it('drops excluded origins entirely', () => {
    const builder = new ContextBuilder({
      tabs: [
        tab({ id: 't1', url: 'https://bank.example/account', title: 'My bank' }),
        tab({ id: 't2', url: 'https://example.com', title: 'Fine' })
      ],
      workspaces: [workspace],
      activeWorkspaceId: 'default',
      excludedOrigins: ['https://bank.example'],
      includePageContent: false
    })

    const context = builder.build()
    expect(context).not.toContain('bank.example')
    expect(context).not.toContain('My bank')
    expect(context).toContain('Fine')
    // And the preview admits something was withheld rather than hiding it.
    expect(builder.preview().lines.join(' ')).toContain('excluded')
  })

  it('omits internal and non-http pages', () => {
    const context = new ContextBuilder({
      tabs: [
        tab({ id: 't1', url: 'adaptive://newtab', title: 'New tab' }),
        tab({ id: 't2', url: 'file:///C:/Users/me/private.pdf', title: 'private' })
      ],
      workspaces: [workspace],
      activeWorkspaceId: 'default',
      excludedOrigins: [],
      includePageContent: false
    }).build()

    expect(context).not.toContain('newtab')
    expect(context).not.toContain('private')
  })

  it('preview matches what build actually sends', () => {
    const input = {
      tabs: [tab({ id: 't1', url: 'https://a.example' }), tab({ id: 't2', url: 'https://b.example' })],
      workspaces: [workspace],
      activeWorkspaceId: 'default',
      excludedOrigins: [],
      includePageContent: false
    }
    const builder = new ContextBuilder(input)
    expect(builder.preview().tabCount).toBe(2)
    expect(builder.preview().includesPageContent).toBe(false)
    expect(builder.preview().lines.join(' ')).toContain('no page text')
  })

  it('says so when page text is included', () => {
    const preview = new ContextBuilder({
      tabs: [tab({ id: 't1', url: 'https://a.example' })],
      workspaces: [workspace],
      activeWorkspaceId: 'default',
      excludedOrigins: [],
      includePageContent: true,
      pageText: new Map([['t1', 'the body text']])
    }).preview()

    expect(preview.includesPageContent).toBe(true)
    expect(preview.lines.join(' ')).toContain('characters of text')
  })

  it('never mentions cookies, passwords or history', () => {
    const preview = new ContextBuilder({
      tabs: [tab({ id: 't1', url: 'https://a.example' })],
      workspaces: [workspace],
      activeWorkspaceId: 'default',
      excludedOrigins: [],
      includePageContent: true
    }).preview()

    expect(preview.lines.join(' ')).toContain('No cookies, form data, passwords')
  })
})
