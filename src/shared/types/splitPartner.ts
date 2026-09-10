import { isInternalUrl } from './tab'

/**
 * Which tab to open beside the current one.
 *
 * **The bug this exists for.** Toggling split view picked the *adjacent* tab and
 * asked for it, whatever it was — and a tab showing the new tab page has no page
 * view at all. That is not a rendering quirk: internal pages are drawn by the
 * chrome document through the content hole, so there is nothing for a pane to
 * composite. `layoutPanes` therefore dropped the split and returned, the palette
 * discarded the result, and pressing Ctrl+Shift+S did visibly nothing.
 *
 * A fresh tab beside the page you are reading is the single most likely thing
 * to be next to it, so the common case was the broken one.
 *
 * Pure, and separated from the palette that calls it, because "which tab is
 * eligible" is a rule worth testing rather than a line inside a click handler.
 */
export interface SplitCandidate {
  readonly id: string
  readonly url: string
}

/**
 * Whether a tab can be shown in a pane at all.
 *
 * Internal pages cannot: no view is attached and the chrome shows through the
 * hole, which is also how the hibernation placeholder and the error page work.
 */
export function canPairWith(tab: SplitCandidate): boolean {
  return !isInternalUrl(tab.url)
}

/**
 * The best tab to pair with the active one, or null when there is none.
 *
 * Searches **outwards from the active tab** rather than taking the next one
 * blindly, so the pane that opens is the nearest real page in either direction —
 * which is what somebody means by "split with the other tab" when the literal
 * neighbour happens to be a blank one.
 */
export function chooseSplitPartner(
  tabs: readonly SplitCandidate[],
  activeTabId: string | null
): SplitCandidate | null {
  const index = tabs.findIndex((tab) => tab.id === activeTabId)
  if (index < 0) {
    // No active tab in the list: the first eligible one is still a better
    // answer than refusing.
    return tabs.find(canPairWith) ?? null
  }

  for (let distance = 1; distance < tabs.length; distance += 1) {
    // After, then before, at each distance. Ties go to the tab on the right,
    // which is where a newly opened one lands.
    const after = tabs[index + distance]
    if (after && canPairWith(after)) return after

    const before = tabs[index - distance]
    if (before && canPairWith(before)) return before
  }

  return null
}
