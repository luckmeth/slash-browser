/**
 * Whether a tab's view should be given a blank document before it navigates.
 *
 * Pure and separate because every clause here was learned from a bug, and two
 * of them were bugs a user saw:
 *
 *  - **A restored tab must never be warmed.** `navigationHistory.restore()`
 *    replaces the entry list on a *pristine* WebContents. Hand it one that has
 *    already committed a document and it replaces the entries without
 *    navigating — the tab keeps the restored address in the omnibox and renders
 *    nothing. Reopening the browser showed a black window with the right URL
 *    above it, on every restored tab.
 *  - **Only http(s).** `about:` and `file:` get nothing: no script here acts on
 *    them, and a blank document before a blank document is pure waste.
 *  - **Only when there is no renderer yet.** A tab that already has one — the
 *    user typing an address into a page they are reading — must not be sent to
 *    `about:blank` first. That is a visible flash and an entry in somebody's
 *    back history, bought for an install that has already happened.
 *  - **Only when there is something to install.** With every page script
 *    switched off there is nothing the blank document buys.
 */
export interface WarmUpFacts {
  /** The address the tab is about to load. */
  readonly url: string
  /** True when this view is being rebuilt with a saved back-forward history. */
  readonly hasSavedNavigation: boolean
  /** `getOSProcessId() > 0` — a view that has never navigated has no renderer. */
  readonly hasRenderer: boolean
  /** Whether any page-world script is switched on. */
  readonly hasScripts: boolean
}

export function shouldWarmUp(facts: WarmUpFacts): boolean {
  // First, because it is the one that shipped a black window.
  if (facts.hasSavedNavigation) return false
  if (!facts.hasScripts) return false
  if (facts.hasRenderer) return false

  try {
    return /^https?:$/.test(new URL(facts.url).protocol)
  } catch {
    return false
  }
}
