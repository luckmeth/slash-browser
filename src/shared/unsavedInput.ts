/**
 * Which edit targets count as "work the user would lose".
 *
 * Split out from the content preload so the decision is unit-testable without a
 * DOM, and so the rule is stated in one place rather than inline in an event
 * handler. Takes only the *shape* of an element — never its contents.
 */

/**
 * Input types that carry no typed text.
 *
 * Toggling a checkbox or picking a radio is a change, but there is nothing to
 * retype if the tab is rebuilt from its URL — the page's own state restoration
 * handles it, and treating it as unsaved work would make forms with a single
 * "remember me" box permanently un-hibernatable.
 */
const VALUELESS_INPUT_TYPES = new Set([
  'hidden',
  'submit',
  'button',
  'reset',
  'image',
  'checkbox',
  'radio',
  'file',
  'range',
  'color'
])

export interface EditTargetShape {
  /** Uppercase tag name, as `element.tagName` reports it. */
  tagName: string
  /** `input.type`, lowercased. Absent for anything that is not an `<input>`. */
  inputType?: string | undefined
  /** `element.isContentEditable`. */
  isContentEditable?: boolean | undefined
  disabled?: boolean | undefined
  readOnly?: boolean | undefined
}

/**
 * Whether an edit to this element means the tab now holds unsaved text.
 *
 * Note what this function does *not* take: the field's value. Whether the user
 * typed is established by the fact that an `input` event fired at all — script
 * assigning `element.value` does not fire one, so the event is a stricter signal
 * than comparing value to defaultValue ever was, and it needs no access to the
 * text itself.
 */
export function countsAsUnsavedWork(target: EditTargetShape): boolean {
  if (target.disabled || target.readOnly) return false

  if (target.tagName === 'INPUT') {
    const type = (target.inputType ?? 'text').toLowerCase()
    return !VALUELESS_INPUT_TYPES.has(type)
  }

  if (target.tagName === 'TEXTAREA') return true

  // Rich-text editors: the tag varies (DIV, SPAN, a custom element), so the
  // contenteditable flag is the only reliable marker.
  return target.isContentEditable === true
}
