import { describe, it, expect } from 'vitest'
import { countsAsUnsavedWork } from './unsavedInput'

describe('countsAsUnsavedWork', () => {
  it('counts text-bearing inputs', () => {
    for (const inputType of ['text', 'email', 'search', 'url', 'tel', 'number', 'date']) {
      expect(countsAsUnsavedWork({ tagName: 'INPUT', inputType })).toBe(true)
    }
  })

  it('counts a password field', () => {
    // Half-typed credentials are still work the user would lose. The point of
    // this module is that we can say so without ever reading the characters.
    expect(countsAsUnsavedWork({ tagName: 'INPUT', inputType: 'password' })).toBe(true)
  })

  it('defaults a typeless input to text', () => {
    // `<input>` with no type attribute is a text field.
    expect(countsAsUnsavedWork({ tagName: 'INPUT' })).toBe(true)
  })

  it('is case-insensitive about the input type', () => {
    expect(countsAsUnsavedWork({ tagName: 'INPUT', inputType: 'PASSWORD' })).toBe(true)
  })

  it('ignores inputs that carry no typed text', () => {
    for (const inputType of ['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'hidden']) {
      expect(countsAsUnsavedWork({ tagName: 'INPUT', inputType })).toBe(false)
    }
  })

  it('counts a textarea', () => {
    expect(countsAsUnsavedWork({ tagName: 'TEXTAREA' })).toBe(true)
  })

  it('counts a contenteditable element of any tag', () => {
    expect(countsAsUnsavedWork({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(countsAsUnsavedWork({ tagName: 'MY-EDITOR', isContentEditable: true })).toBe(true)
  })

  it('ignores an ordinary element that merely received an event', () => {
    expect(countsAsUnsavedWork({ tagName: 'DIV' })).toBe(false)
    expect(countsAsUnsavedWork({ tagName: 'DIV', isContentEditable: false })).toBe(false)
  })

  it('ignores disabled and readonly fields', () => {
    expect(countsAsUnsavedWork({ tagName: 'INPUT', inputType: 'text', disabled: true })).toBe(false)
    expect(countsAsUnsavedWork({ tagName: 'TEXTAREA', readOnly: true })).toBe(false)
  })
})
