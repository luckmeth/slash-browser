import { describe, expect, it } from 'vitest'
import { splitHint } from './settingsText'

describe('splitHint', () => {
  it('leads with the first sentence and hides the rest', () => {
    const { lead, rest } = splitHint(
      'Downloads are sorted into folders by kind. Anything Slash cannot classify stays at the top level.'
    )
    expect(lead).toBe('Downloads are sorted into folders by kind.')
    expect(rest).toBe('Anything Slash cannot classify stays at the top level.')
  })

  it('shows a single sentence whole, with nothing hidden', () => {
    const { lead, rest } = splitHint('Only needed if yt-dlp is not on your PATH.')
    expect(lead).toBe('Only needed if yt-dlp is not on your PATH.')
    expect(rest).toBe('')
  })

  it('does not split inside a decimal', () => {
    // "Parsing 4.3 MB takes ~770 ms" must not become two sentences.
    const { lead, rest } = splitHint('Compiling 4.3 MB of rules takes 770 ms on this machine.')
    expect(lead).toBe('Compiling 4.3 MB of rules takes 770 ms on this machine.')
    expect(rest).toBe('')
  })

  it('does not split on a lowercase continuation', () => {
    const { lead } = splitHint('Uses net.request rather than node http for every fetch.')
    expect(lead).toContain('node http')
  })

  it('absorbs a fragment first sentence rather than hiding the explanation', () => {
    // "Off by default." on its own tells nobody anything, and hiding the
    // sentence that explains it behind a control helps less than showing both.
    const { lead, rest } = splitHint(
      'Off by default. Turning it on means files stop appearing where the last one did. Some people prefer that.'
    )
    expect(lead).toBe('Off by default. Turning it on means files stop appearing where the last one did.')
    expect(rest).toBe('Some people prefer that.')
  })

  it('keeps a short hint whole when there is nothing after it', () => {
    expect(splitHint('Off by default.')).toEqual({ lead: 'Off by default.', rest: '' })
  })

  it('splits after a question mark', () => {
    const { lead, rest } = splitHint('Should Slash ask every time? Turning this off uses one folder.')
    expect(lead).toBe('Should Slash ask every time?')
    expect(rest).toBe('Turning this off uses one folder.')
  })

  it('handles an absent hint', () => {
    expect(splitHint(undefined)).toEqual({ lead: '', rest: '' })
    expect(splitHint('   ')).toEqual({ lead: '', rest: '' })
  })

  it('never loses text', () => {
    // The whole point is progressive disclosure, not truncation.
    const hint =
      'Some sites serve video no browser can save. Reaching those means defeating access controls. Slash does not do that.'
    const { lead, rest } = splitHint(hint)
    expect(`${lead} ${rest}`.trim()).toBe(hint)
  })
})
