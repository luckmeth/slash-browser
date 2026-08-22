/**
 * Which tab a media key should act on.
 *
 * Pure, because the answer is a judgement rather than a lookup and getting it
 * wrong is maddening in a way that is hard to report: the user presses pause,
 * something else pauses, and the thing making noise carries on. Three tabs can
 * plausibly claim the keys — the one playing, the one they are looking at, and
 * the one they last paused — and only one of them is right.
 */

export interface MediaCandidate {
  readonly id: string
  readonly isAudible: boolean
  readonly isMuted: boolean
  /** Unix ms when this tab last started making sound, or 0 if never. */
  readonly lastAudibleAt: number
  readonly isActive: boolean
}

/**
 * The tab a play/pause press belongs to, or null.
 *
 * In order:
 *
 *  1. **Something currently making sound**, most recent first. Pause must stop
 *     what you can hear, not what you were looking at.
 *  2. **The tab in front**, if it has played before. Someone watching a paused
 *     video expects space-bar-by-another-name to resume *this* one.
 *  3. **Whatever last played.** Resuming what you paused a minute ago is the
 *     only sensible reading of "play" when nothing is audible.
 *
 * A muted tab never wins on audibility alone — it cannot be what the user is
 * hearing — but it can still be chosen at step 2 or 3, because pressing play on
 * the video in front of you should work whether or not you muted it.
 */
export function chooseMediaTarget(candidates: readonly MediaCandidate[]): string | null {
  if (candidates.length === 0) return null

  const audible = candidates
    .filter((tab) => tab.isAudible && !tab.isMuted)
    .sort((a, b) => b.lastAudibleAt - a.lastAudibleAt)
  if (audible.length > 0) return audible[0]!.id

  const active = candidates.find((tab) => tab.isActive && tab.lastAudibleAt > 0)
  if (active) return active.id

  const everPlayed = candidates
    .filter((tab) => tab.lastAudibleAt > 0)
    .sort((a, b) => b.lastAudibleAt - a.lastAudibleAt)
  return everPlayed[0]?.id ?? null
}

/**
 * Tabs to list in a "now playing" control.
 *
 * Muted tabs are included — a tab you muted is still a tab making a video play,
 * and hiding it is how a user ends up hunting for the row that lets them unmute
 * it. Sorted by how recently each started, so the newest noise is at the top,
 * which is what somebody hunting for it is looking for.
 */
export function nowPlaying(candidates: readonly MediaCandidate[]): MediaCandidate[] {
  return candidates
    .filter((tab) => tab.isAudible || (tab.isMuted && tab.lastAudibleAt > 0))
    .sort((a, b) => b.lastAudibleAt - a.lastAudibleAt)
}
