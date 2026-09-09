import { describe, it, expect, vi } from 'vitest'
import type { WebContents } from 'electron'
import { ShieldVerifier, expectsStrip, verdictFor, type ShieldVerification } from './ShieldVerifier'

function fakeContents(answer: unknown, options: { destroyed?: boolean; throws?: boolean } = {}) {
  return {
    isDestroyed: () => options.destroyed ?? false,
    executeJavaScript: vi.fn(async () => {
      if (options.throws) throw new Error('page refused')
      return answer
    })
  } as unknown as WebContents
}

function make(enabled = true): { verifier: ShieldVerifier; states: ShieldVerification[] } {
  const states: ShieldVerification[] = []
  const verifier = new ShieldVerifier(
    () => enabled,
    (state) => states.push(state)
  )
  return { verifier, states }
}

describe('expectsStrip', () => {
  it.each([
    'https://www.youtube.com/watch?v=x',
    'https://youtube.com/',
    'https://m.youtube.com/',
    'https://www.youtube-nocookie.com/embed/x'
  ])('expects the strip on %s', (url) => {
    expect(expectsStrip(url)).toBe(true)
  })

  it.each([
    'https://example.com/',
    'https://notyoutube.com/',
    // The lookalike. A substring match would call this YouTube and then report
    // a failure on every visit, which is worse than not checking.
    'https://youtube.com.evil.test/',
    'https://myyoutube.com/',
    'about:blank',
    'not a url'
  ])('does not expect the strip on %s', (url) => {
    expect(expectsStrip(url)).toBe(false)
  })
})

describe('verdictFor', () => {
  it('reports off when the feature is switched off', () => {
    expect(verdictFor({ enabled: false, ran: false })).toBe('off')
    expect(verdictFor({ enabled: false, ran: true })).toBe('off')
  })

  it('separates "could not read" from "did not run"', () => {
    // The distinction this whole check rests on. A browser that reports an
    // unreadable page as a broken ad blocker teaches people to ignore it.
    expect(verdictFor({ enabled: true, ran: null })).toBe('unknown')
    expect(verdictFor({ enabled: true, ran: false })).toBe('failed')
  })

  it('reports verified when the marker was there', () => {
    expect(verdictFor({ enabled: true, ran: true })).toBe('verified')
  })
})

describe('ShieldVerifier', () => {
  it('starts with nothing to report', () => {
    expect(make().verifier.current().verdict).toBe('unknown')
    expect(make().verifier.current().at).toBeNull()
  })

  it('ignores pages the strip was never meant to run on', async () => {
    const { verifier, states } = make()
    const contents = fakeContents(false)
    await verifier.notePageLoaded(contents, 'https://example.com/')
    expect(states).toEqual([])
    expect(contents.executeJavaScript).not.toHaveBeenCalled()
  })

  it('verifies when the marker is present', async () => {
    const { verifier, states } = make()
    await verifier.notePageLoaded(fakeContents(true), 'https://www.youtube.com/watch?v=x')
    expect(states.at(-1)?.verdict).toBe('verified')
    expect(states.at(-1)?.host).toBe('www.youtube.com')
    expect(states.at(-1)?.at).toBeTypeOf('number')
  })

  it('fails when the script did not run — the bug that shipped', async () => {
    const { verifier, states } = make()
    await verifier.notePageLoaded(fakeContents(false), 'https://www.youtube.com/watch?v=x')
    expect(states.at(-1)?.verdict).toBe('failed')
  })

  it('reports unknown when the page could not be read', async () => {
    const { verifier, states } = make()
    await verifier.notePageLoaded(
      fakeContents(null, { throws: true }),
      'https://www.youtube.com/watch?v=x'
    )
    expect(states.at(-1)?.verdict).toBe('unknown')
  })

  it('reports unknown when the page answers with something that is not a boolean', async () => {
    const { verifier, states } = make()
    await verifier.notePageLoaded(fakeContents('yes'), 'https://www.youtube.com/watch?v=x')
    expect(states.at(-1)?.verdict).toBe('unknown')
  })

  it('reports off without touching the page when the feature is off', async () => {
    const { verifier, states } = make(false)
    const contents = fakeContents(true)
    await verifier.notePageLoaded(contents, 'https://www.youtube.com/watch?v=x')
    expect(states.at(-1)?.verdict).toBe('off')
    expect(contents.executeJavaScript).not.toHaveBeenCalled()
  })

  it('checks once per session, not once per page', async () => {
    // Principle 1: this must not become a cost paid on every YouTube
    // navigation. The fault it catches is not intermittent.
    const { verifier } = make()
    const first = fakeContents(true)
    const second = fakeContents(true)
    await verifier.notePageLoaded(first, 'https://www.youtube.com/watch?v=a')
    await verifier.notePageLoaded(second, 'https://www.youtube.com/watch?v=b')
    expect(first.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(second.executeJavaScript).not.toHaveBeenCalled()
  })

  it('checks again after the shield settings change', async () => {
    const { verifier } = make()
    const first = fakeContents(true)
    await verifier.notePageLoaded(first, 'https://www.youtube.com/watch?v=a')

    verifier.reset()
    const second = fakeContents(true)
    await verifier.notePageLoaded(second, 'https://www.youtube.com/watch?v=b')
    expect(second.executeJavaScript).toHaveBeenCalledTimes(1)
  })

  it('clears a stale verdict on reset rather than leaving the old one showing', () => {
    const { verifier, states } = make()
    verifier.reset()
    expect(states.at(-1)?.verdict).toBe('unknown')
    expect(states.at(-1)?.at).toBeNull()
  })

  it('does not try to read a destroyed view', async () => {
    const { verifier, states } = make()
    await verifier.notePageLoaded(
      fakeContents(true, { destroyed: true }),
      'https://www.youtube.com/watch?v=x'
    )
    expect(states.at(-1)?.verdict).toBe('unknown')
  })
})
