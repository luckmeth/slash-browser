import { describe, it, expect } from 'vitest'
import {
  ASSISTANTS,
  DEFAULT_ASSISTANT_ID,
  assistantLabelFor,
  assistantUrlFor,
  isAssistantUrl
} from './assistants'

describe('the assistant list', () => {
  it('has a default that exists', () => {
    expect(ASSISTANTS.some((a) => a.id === DEFAULT_ASSISTANT_ID)).toBe(true)
  })

  it('points every entry at https', () => {
    // The pane holds a signed-in session. Plaintext is not an option.
    for (const assistant of ASSISTANTS) {
      expect(assistant.url.startsWith('https://')).toBe(true)
    }
  })

  it('gives every entry at least one host to match on', () => {
    for (const assistant of ASSISTANTS) {
      expect(assistant.hosts.length).toBeGreaterThan(0)
    }
  })
})

describe('assistantUrlFor', () => {
  it('resolves a known assistant', () => {
    expect(assistantUrlFor('claude', '')).toBe('https://claude.ai/new')
  })

  it('returns nothing for an id that is not one', () => {
    expect(assistantUrlFor('nonsense', '')).toBeNull()
  })

  it('accepts a custom https address', () => {
    expect(assistantUrlFor('custom', ' https://ai.example.com/chat ')).toBe(
      'https://ai.example.com/chat'
    )
  })

  it('refuses a custom address that is not https', () => {
    // Not defensiveness: this pane keeps a signed-in session, and sending those
    // cookies in plaintext is not a decision to leave to a text field.
    expect(assistantUrlFor('custom', 'http://ai.example.com')).toBeNull()
    expect(assistantUrlFor('custom', 'javascript:alert(1)')).toBeNull()
    expect(assistantUrlFor('custom', '')).toBeNull()
  })
})

describe('isAssistantUrl', () => {
  it('recognises the assistant it is already on', () => {
    expect(isAssistantUrl('https://claude.ai/chat/abc123', 'claude', '')).toBe(true)
  })

  it('recognises a subdomain, so a sign-in redirect is not a second tab', () => {
    expect(isAssistantUrl('https://www.claude.ai/', 'claude', '')).toBe(true)
  })

  it('recognises a legacy host the service still redirects from', () => {
    expect(isAssistantUrl('https://chat.openai.com/c/1', 'chatgpt', '')).toBe(true)
  })

  it('does not mistake another site for it', () => {
    expect(isAssistantUrl('https://example.com/claude.ai', 'claude', '')).toBe(false)
    expect(isAssistantUrl('https://notclaude.ai/', 'claude', '')).toBe(false)
  })

  it('does not match a different assistant', () => {
    expect(isAssistantUrl('https://chatgpt.com/', 'claude', '')).toBe(false)
  })

  it('handles a custom address', () => {
    expect(isAssistantUrl('https://ai.example.com/x', 'custom', 'https://ai.example.com/chat')).toBe(
      true
    )
    expect(isAssistantUrl('https://other.example.com/', 'custom', 'https://ai.example.com')).toBe(
      false
    )
  })

  it('says no rather than throwing on an unparseable URL', () => {
    expect(isAssistantUrl('slash://newtab', 'claude', '')).toBe(false)
    expect(isAssistantUrl('', 'claude', '')).toBe(false)
  })
})

describe('assistantLabelFor', () => {
  it('names the assistant', () => {
    expect(assistantLabelFor('claude')).toBe('Claude')
  })

  it('falls back to something neutral', () => {
    expect(assistantLabelFor('custom')).toBe('Assistant')
    expect(assistantLabelFor('nonsense')).toBe('Assistant')
  })
})
