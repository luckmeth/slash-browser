/**
 * Whether a keystroke on the start page should start a search.
 *
 * Opening a tab and typing should search, without aiming at the box first —
 * that is what every other browser does and its absence is felt immediately.
 * The whole difficulty is deciding which keystrokes mean "I am typing a query"
 * and which mean something else, because stealing a shortcut is far worse than
 * missing a character.
 *
 * Pure, so each refusal is a tested rule rather than a condition buried in a
 * listener.
 */
export interface KeyFacts {
  /** `KeyboardEvent.key`. */
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  /** Tag name of whatever currently has focus, upper case. */
  readonly targetTag: string
  /** Whether the focused element is editable (an input, or contenteditable). */
  readonly targetEditable: boolean
}

export function shouldStartTyping(facts: KeyFacts): boolean {
  // Ctrl+L, Ctrl+T, Alt+Left, ⌘+W. Every one of these is a command, and
  // swallowing it into a search box would break the browser's own shortcuts.
  // AltGr arrives as ctrl+alt together and *does* produce characters, which is
  // how several European layouts type @ and #, so it is deliberately allowed.
  if (facts.metaKey) return false
  if (facts.ctrlKey && !facts.altKey) return false
  if (facts.altKey && !facts.ctrlKey) return false

  // Already typing somewhere — an input, a textarea, a contenteditable. Moving
  // focus here would eat a character from whatever they were actually filling
  // in.
  if (facts.targetEditable) return false
  if (facts.targetTag === 'INPUT' || facts.targetTag === 'TEXTAREA') return false

  // Exactly one character: a letter, a digit, a symbol, or a space. `key` is
  // multi-character for every non-printable key — 'Enter', 'Tab', 'ArrowDown',
  // 'F5', 'Escape', 'Backspace' — so this single test excludes all of them
  // without a list to keep up to date.
  if ([...facts.key].length !== 1) return false

  // A space alone is how a page is scrolled, and on the start page it is also
  // the least likely first character of a search.
  if (facts.key === ' ') return false

  return true
}
