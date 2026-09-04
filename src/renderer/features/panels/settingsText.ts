/**
 * Splitting a setting's explanation into a summary and the rest.
 *
 * This browser explains itself at length, and that is deliberate — principle 7
 * is that permissions and security decisions are stated in plain language, and
 * several of these settings have real costs that ought to be said out loud.
 * Rendered all at once, though, it reads as a wall: seventeen groups of
 * three-line paragraphs, none of which can be skimmed, so the screen is hard to
 * use *because* it is honest.
 *
 * The fix is not to delete the explanations. It is to lead with one line and
 * keep the rest a click away. Scanning works, and nothing is lost.
 *
 * Pure, so the sentence-splitting can be tested against the awkward cases —
 * abbreviations, decimals, ellipses — rather than discovered on a settings
 * screen that has quietly cut a sentence in half.
 */
export interface SplitHint {
  /** The first sentence, always shown. */
  readonly lead: string
  /** Everything after it, behind a disclosure. Empty when there is none. */
  readonly rest: string
}

/**
 * A full stop that ends a sentence, rather than one inside a number or an
 * abbreviation. Requires whitespace and a capital (or a digit) after it, which
 * is what separates "…per client. Eight megabytes…" from "…4.3 MB…".
 */
const SENTENCE_END = /([.!?])\s+(?=[A-Z0-9“"'])/

/** Below this, a second sentence is not worth hiding behind a control. */
const MIN_LEAD = 24

export function splitHint(hint: string | undefined): SplitHint {
  const text = (hint ?? '').trim()
  if (text === '') return { lead: '', rest: '' }

  const match = SENTENCE_END.exec(text)
  if (!match || match.index === undefined) return { lead: text, rest: '' }

  const cut = match.index + 1
  const lead = text.slice(0, cut).trim()
  const rest = text.slice(cut).trim()

  // A very short first sentence — "Off by default." — is a fragment rather than
  // a summary, and hiding the sentence that explains it helps nobody.
  if (lead.length < MIN_LEAD) {
    const second = SENTENCE_END.exec(rest)
    if (!second || second.index === undefined) return { lead: text, rest: '' }
    const secondCut = second.index + 1
    return {
      lead: `${lead} ${rest.slice(0, secondCut).trim()}`,
      rest: rest.slice(secondCut).trim()
    }
  }

  return { lead, rest }
}
