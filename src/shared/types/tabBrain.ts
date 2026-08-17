import { z } from 'zod'

/**
 * Autonomous Tab Brain.
 *
 * Finds the structure already present in a pile of open tabs: which are the same
 * page twice, which belong to one piece of work, which have been abandoned.
 *
 * **All of it is computed locally, with no AI involved.** That is a requirement
 * rather than an optimisation — the browser has to be fully usable with AI
 * switched off, and a tab organiser that only works once you have configured a
 * provider and agreed to send it your tab titles would be useless to most people
 * and a privacy problem for the rest. Clustering runs on titles and URLs the
 * browser already holds. An AI may later be asked to improve a group's *name*;
 * it is never needed to find the group.
 *
 * Nothing here closes anything. Every finding is a suggestion the user confirms,
 * because a button press is not a good enough reason to destroy a half-filled
 * form.
 */

export const TabGroupSchema = z.object({
  /** Stable within one analysis run; not persisted. */
  id: z.string(),
  /** Derived from the terms the group's tabs actually share. */
  name: z.string(),
  tabIds: z.array(z.string()),
  /**
   * Why these tabs were grouped, in plain language.
   *
   * A grouping the user cannot understand is one they cannot correct, and the
   * clustering is a heuristic that will sometimes be wrong.
   */
  reason: z.string(),
  /** Hosts represented, most common first. Shown as the group's fingerprint. */
  hosts: z.array(z.string())
})
export type TabGroup = z.infer<typeof TabGroupSchema>

export const DuplicateSetSchema = z.object({
  /** Canonical URL the members share. */
  url: z.string(),
  title: z.string(),
  tabIds: z.array(z.string()),
  /**
   * True when the URLs match byte for byte, false when they matched only after
   * normalising away tracking parameters and fragments.
   *
   * Worth distinguishing: two tabs on the same article via different campaign
   * links are the same page, but two tabs on different anchors of a long
   * document may genuinely both be wanted.
   */
  exact: z.boolean()
})
export type DuplicateSet = z.infer<typeof DuplicateSetSchema>

export const CloseSuggestionSchema = z.object({
  tabId: z.string(),
  title: z.string(),
  url: z.string(),
  /** Plain-language justification, shown next to the tab. */
  reason: z.string(),
  /** Hours since the tab was last looked at. */
  idleHours: z.number()
})
export type CloseSuggestion = z.infer<typeof CloseSuggestionSchema>

export const TabAnalysisSchema = z.object({
  tabCount: z.number().int(),
  groups: z.array(TabGroupSchema),
  duplicates: z.array(DuplicateSetSchema),
  closeSuggestions: z.array(CloseSuggestionSchema),
  /** Tabs that fell into no group. Not a problem — just unclustered. */
  ungroupedTabIds: z.array(z.string()),
  /** One-line account of what was found, or why nothing was. */
  summary: z.string()
})
export type TabAnalysis = z.infer<typeof TabAnalysisSchema>

/**
 * Token overlap above which two tabs are considered related.
 *
 * Tuned deliberately low. The cost of a wrong grouping is a suggestion the user
 * ignores; the cost of grouping nothing is a feature that appears broken. Set
 * from the observed behaviour of real tab sets rather than derived from theory.
 */
export const SIMILARITY_THRESHOLD = 0.26

/** Below this a "group" is just two tabs, which the user can already see. */
export const MIN_GROUP_SIZE = 3

/** Idle hours after which a tab is offered as closeable. */
export const IDLE_CLOSE_HOURS = 72
