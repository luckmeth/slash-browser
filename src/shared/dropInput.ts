/**
 * What a drop onto the browser means.
 *
 * Dropping a link should open it; dropping a sentence should search for it. The
 * decision is one step earlier than that: a drag carries *several*
 * representations of the same thing at once, and picking the wrong one is how a
 * dropped link becomes a search for its own anchor text.
 *
 * Pure, so the ordering is a tested rule rather than whatever
 * `dataTransfer.getData` happened to return first.
 */
export interface DropPayload {
  /** `text/uri-list` — what a dragged link carries. */
  uriList?: string
  /** `text/plain` — a selection, or a link's address again. */
  text?: string
}

/**
 * The first real address in a `text/uri-list`.
 *
 * RFC 2483 allows comment lines beginning with `#`, and a drag from some
 * applications carries several URLs. Taking `split('\n')[0]` blindly can
 * therefore return a comment.
 */
function firstUri(list: string): string | null {
  for (const line of list.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    return trimmed
  }
  return null
}

/**
 * The text to hand to navigation, or null when there is nothing usable.
 *
 * `uri-list` wins when present: it is the *address* of a dragged link, whereas
 * the plain-text flavour of the same drag is often the link's visible words. A
 * link reading "click here" would otherwise become a web search for "click
 * here", which is the single most likely way this feature could feel broken.
 *
 * Everything else falls through to the text, which `nav:navigate` already knows
 * how to read — it is the same resolution the omnibox uses, so "example.com"
 * navigates and "how tall is everest" searches, and the two surfaces cannot
 * disagree about which is which.
 */
export function droppedInput(payload: DropPayload): string | null {
  const uri = payload.uriList ? firstUri(payload.uriList) : null
  if (uri !== null && uri !== '') return uri

  const text = payload.text?.trim()
  if (text === undefined || text === '') return null

  // A multi-line selection is a search, not an address, and newlines in a
  // query string are never what somebody meant. Collapsed rather than rejected.
  return text.replace(/\s+/g, ' ').slice(0, 2048)
}
