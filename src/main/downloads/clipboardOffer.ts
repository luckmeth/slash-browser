/**
 * Deciding whether a piece of the clipboard is a download worth offering.
 *
 * Split from `ClipboardWatcher` so it can be tested: `npm test` runs pure logic
 * only and nothing here may import electron. That matters more than usual for
 * this function — it is the gate that decides whether the user's clipboard is
 * looked at any further, so "does it reject a password" needs to be a test
 * rather than a claim.
 */

import { looksLikeFile } from './guardian/linkAnalysis'

export interface ClipboardOffer {
  readonly url: string
  /** The filename the address implies, for the offer text. */
  readonly filename: string
}

/** Longest clipboard text worth even looking at. A URL is not a document. */
const MAX_CLIPBOARD_CHARS = 2048

/**
 * Whether this clipboard text is a download worth offering.
 *
 * Pure and exported so the judgement is tested rather than trusted — this is
 * the function that decides whether a piece of the user's clipboard is looked
 * at any further, and it should be provably narrow.
 */
export function readOffer(raw: string): ClipboardOffer | null {
  if (raw === '' || raw.length > MAX_CLIPBOARD_CHARS) return null

  const text = raw.trim()
  // One line only. Copied prose that happens to contain a link is not somebody
  // asking to download it, and treating it as such would offer on every copied
  // paragraph from a web page.
  if (/\s/.test(text)) return null
  if (!/^https?:\/\//i.test(text)) return null

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }

  // Only what the guardian already recognises as a file. A copied article
  // address is not a download, and offering on one would make the feature
  // fire constantly while browsing.
  if (!looksLikeFile(url.toString())) return null

  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
  return { url: url.toString(), filename: last === '' ? url.hostname : last }
}
