import { similarity, tokenize } from '../tabs/brain/tabAnalysis'

/**
 * Deciding whether a page belongs to the mission the user is on.
 *
 * Reuses Tab Brain's tokenizer rather than growing a second one: two functions
 * that both answer "are these about the same thing" and can disagree is a bug
 * waiting to happen, and the stop-word list is the part that took tuning.
 *
 * Pure, and deliberately biased towards *not* interrupting. A false "this looks
 * off-mission" on a page the user needs is far more annoying than staying quiet
 * on a genuine distraction — they already know they are distracted.
 */

/**
 * Score above which a page counts as on-mission.
 *
 * Lower than the tab-clustering threshold on purpose. A mission goal is a short
 * sentence — "finish my research paper" — so it shares few tokens with any single
 * page even when they are plainly related, and the same bar would call everything
 * off-mission.
 */
export const ON_MISSION_THRESHOLD = 0.08

/**
 * Strips the site-brand suffix most pages append to their title.
 *
 * "Premier League - Wikipedia" and "Coral bleaching - Wikipedia" share the word
 * *Wikipedia* and nothing else, which was enough to pull a football page into a
 * coral-reef mission. The suffix is boilerplate the site adds to every page, so
 * it says nothing about the topic and is removed before comparing.
 *
 * Only a short trailing segment is taken — a title genuinely containing a dash
 * mid-sentence keeps its words.
 */
export function stripSiteSuffix(title: string): string {
  const match = /^(.*?)\s+[-|–—]\s+([^-|–—]{1,30})$/.exec(title.trim())
  return match?.[1]?.trim() || title.trim()
}

export interface MissionPage {
  url: string
  title: string
}

export interface RelevanceVerdict {
  onMission: boolean
  score: number
  /** Terms the page shares with the mission, for explaining the verdict. */
  shared: string[]
}

/**
 * Scores a page against the mission goal and whatever is already in the mission.
 *
 * The mission's existing pages matter as much as its goal text: a goal of "plan
 * my trip" shares nothing with "Shinkansen timetable", but a mission already
 * holding three pages about Japanese rail does. So the comparison is against the
 * goal *and* the accumulated context, taking the best match.
 */
export function scoreRelevance(
  page: MissionPage,
  goal: string,
  missionPages: readonly MissionPage[]
): RelevanceVerdict {
  // Host excluded throughout: a mission accumulating pages from one site would
  // otherwise match anything else on that site. Found by a probe where a football
  // page joined a coral-reef mission because both were on Wikipedia.
  const pageTokens = tokenize({ ...page, title: stripSiteSuffix(page.title) }, { includeHost: false })
  // Nothing to judge on, so nothing is said. With the host excluded and the site
  // suffix stripped, a bare domain with no title yields no tokens at all — which
  // is the precise condition, and a count-based floor was not: it also swallowed
  // real two-word titles like "Premier League" and called them on-mission.
  if (pageTokens.size === 0) {
    return { onMission: true, score: 1, shared: [] }
  }

  const goalTokens = tokenize({ title: goal, url: '' }, { includeHost: false })
  let best = similarity(pageTokens, goalTokens)
  let bestAgainst = goalTokens

  for (const existing of missionPages) {
    const existingTokens = tokenize(
      { ...existing, title: stripSiteSuffix(existing.title) },
      { includeHost: false }
    )
    const score = similarity(pageTokens, existingTokens)
    if (score > best) {
      best = score
      bestAgainst = existingTokens
    }
  }

  const shared = [...pageTokens].filter((token) => bestAgainst.has(token)).slice(0, 5)
  return { onMission: best >= ON_MISSION_THRESHOLD, score: best, shared }
}

/**
 * The suggestion to show, or null to stay silent.
 *
 * Returns null for anything that is not clearly a digression, because the whole
 * feature depends on the prompt being rare enough to still be worth reading. It
 * is also phrased as an offer rather than a warning: this is the user's browser,
 * and they are allowed to open whatever they like.
 */
export function suggestionFor(verdict: RelevanceVerdict, goal: string): string | null {
  if (verdict.onMission) return null
  return `Your current mission is “${goal}”. This page does not look related — save it for later?`
}
