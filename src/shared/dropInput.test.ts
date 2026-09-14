import { describe, it, expect } from 'vitest'
import { droppedInput } from './dropInput'

describe('droppedInput', () => {
  it('takes the address of a dragged link, not its words', () => {
    // The case that decides whether this feature feels broken. A drag carries
    // both, and a link reading "click here" would otherwise become a web search
    // for "click here".
    expect(
      droppedInput({ uriList: 'https://example.com/page', text: 'click here' })
    ).toBe('https://example.com/page')
  })

  it('skips comment lines in a uri-list', () => {
    // RFC 2483 allows them, and some applications send them, so `split[0]`
    // would hand navigation a `#` comment.
    expect(
      droppedInput({ uriList: '# a comment\r\nhttps://example.com/real' })
    ).toBe('https://example.com/real')
  })

  it('takes the first address when several are dragged', () => {
    expect(droppedInput({ uriList: 'https://one.test/\nhttps://two.test/' })).toBe(
      'https://one.test/'
    )
  })

  it('falls back to dropped text', () => {
    expect(droppedInput({ text: 'how tall is everest' })).toBe('how tall is everest')
  })

  it('collapses a multi-line selection into one query', () => {
    // A paragraph dragged out of a page is a search. Newlines in a query string
    // are never what somebody meant.
    expect(droppedInput({ text: 'first line\n\nsecond   line' })).toBe('first line second line')
  })

  it('trims, because a drag usually brings whitespace with it', () => {
    expect(droppedInput({ text: '  spaced out  ' })).toBe('spaced out')
  })

  it('returns null when there is nothing usable', () => {
    expect(droppedInput({})).toBeNull()
    expect(droppedInput({ text: '   ' })).toBeNull()
    expect(droppedInput({ uriList: '', text: '' })).toBeNull()
    expect(droppedInput({ uriList: '# only a comment' })).toBeNull()
  })

  it('falls through to text when the uri-list holds only comments', () => {
    expect(droppedInput({ uriList: '# nothing here', text: 'a search' })).toBe('a search')
  })

  it('caps absurdly long drops rather than handing them on whole', () => {
    const huge = 'x'.repeat(5000)
    expect(droppedInput({ text: huge })?.length).toBe(2048)
  })
})
