/**
 * What there is to go back to.
 *
 * "Resume your work" is the kind of feature that invites invention — a
 * confident card reading *Slash Browser Development · 18 tabs · yesterday* is
 * easy to draw and easy to make up. Everything here comes from something the
 * browser already recorded: a restore point it wrote, or a workspace with tabs
 * open in it right now. Nothing is inferred about what the work *was*.
 *
 * Pure, so the ordering and the wording can be asserted rather than eyeballed
 * on a page that only looks right when you happen to have the right history.
 */

export interface ResumeSnapshot {
  readonly id: number
  readonly label: string
  readonly kind: 'automatic' | 'manual' | 'session-end'
  readonly createdAt: number
  readonly tabCount: number
  readonly workspaceCount: number
}

export interface ResumeWorkspace {
  readonly id: string
  readonly name: string
  readonly icon: string
  readonly isolated: boolean
}

export interface ResumeTab {
  readonly workspaceId: string
  readonly lastActiveAt: number
  /** Internal pages are not work. A window of new tabs is not a session. */
  readonly isInternal: boolean
}

export type ResumeKind = 'session' | 'restore-point' | 'workspace'

export interface ResumeCard {
  readonly id: string
  readonly kind: ResumeKind
  readonly title: string
  /** The one line under the title. Only counts that were actually recorded. */
  readonly detail: string
  /** Epoch ms this card is "from", for ordering and for the relative time. */
  readonly at: number
  /** What the card acts on — a snapshot id, or a workspace id. */
  readonly target: number | string
  /** True for the workspace the user is looking at right now. */
  readonly current?: boolean
}

/**
 * How long a restore point stays worth offering.
 *
 * A fortnight. Older than that and "resume" is archaeology rather than picking
 * up where you left off — the Time Machine panel still lists everything, which
 * is the right place for a list that goes back for ever.
 */
export const RESUME_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/** At most this many cards, so the start page does not become a list. */
export const RESUME_LIMIT = 4

export interface ResumeInput {
  readonly snapshots: readonly ResumeSnapshot[]
  readonly workspaces: readonly ResumeWorkspace[]
  readonly tabs: readonly ResumeTab[]
  readonly activeWorkspaceId: string
  readonly now: number
}

export function resumeCards(input: ResumeInput): ResumeCard[] {
  const cards: ResumeCard[] = []
  const fresh = input.snapshots.filter(
    (snapshot) =>
      snapshot.tabCount > 0 && input.now - snapshot.createdAt <= RESUME_WINDOW_MS
  )

  /*
   * The last session first, whatever its age within the window.
   *
   * It is the one card that answers "I closed the browser and I want my tabs
   * back", which is the whole of what most people mean by resuming, and it is
   * written at quit specifically for this.
   */
  const lastSession = fresh.find((snapshot) => snapshot.kind === 'session-end')
  if (lastSession) {
    cards.push({
      id: `session-${lastSession.id}`,
      kind: 'session',
      title: 'When you last closed the browser',
      detail: countPhrase(lastSession.tabCount, lastSession.workspaceCount),
      at: lastSession.createdAt,
      target: lastSession.id
    })
  }

  /*
   * Then workspaces that have work open in them, most recently touched first.
   *
   * A workspace holding nothing but new tab pages is not work, so it is not
   * offered — that is the difference between a card worth clicking and a list
   * of everything that exists.
   */
  const byWorkspace = new Map<string, { count: number; at: number }>()
  for (const tab of input.tabs) {
    if (tab.isInternal) continue
    const seen = byWorkspace.get(tab.workspaceId)
    if (seen) {
      seen.count += 1
      seen.at = Math.max(seen.at, tab.lastActiveAt)
    } else {
      byWorkspace.set(tab.workspaceId, { count: 1, at: tab.lastActiveAt })
    }
  }

  const workspaceCards: ResumeCard[] = []
  for (const workspace of input.workspaces) {
    const live = byWorkspace.get(workspace.id)
    if (!live) continue
    workspaceCards.push({
      id: `ws-${workspace.id}`,
      kind: 'workspace',
      title: workspace.name,
      detail: `${live.count} ${live.count === 1 ? 'tab' : 'tabs'} open`,
      at: live.at,
      target: workspace.id,
      current: workspace.id === input.activeWorkspaceId
    })
  }
  workspaceCards.sort((a, b) => b.at - a.at)
  cards.push(...workspaceCards)

  /*
   * Then named restore points, which are the ones somebody chose to keep.
   *
   * Automatic snapshots are deliberately not offered here. There is one every
   * five minutes, they are all called the same thing, and a resume list made of
   * them is a list of moments rather than of work.
   */
  const named = fresh
    .filter((snapshot) => snapshot.kind === 'manual')
    .sort((a, b) => b.createdAt - a.createdAt)
  for (const snapshot of named) {
    cards.push({
      id: `snap-${snapshot.id}`,
      kind: 'restore-point',
      title: snapshot.label,
      detail: countPhrase(snapshot.tabCount, snapshot.workspaceCount),
      at: snapshot.createdAt,
      target: snapshot.id
    })
  }

  return cards.slice(0, RESUME_LIMIT)
}

function countPhrase(tabCount: number, workspaceCount: number): string {
  const tabs = `${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'}`
  return workspaceCount > 1 ? `${tabs} across ${workspaceCount} workspaces` : tabs
}

/**
 * How long ago, in the words people use.
 *
 * Deliberately coarse. "Yesterday" is true for a range of hours and nobody
 * needs the minutes; a precise figure on a card like this invites reading it as
 * a measurement of something.
 */
export function agoPhrase(at: number, now: number): string {
  const ms = now - at
  if (ms < 0) return 'just now'

  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`

  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`

  const weeks = Math.floor(days / 7)
  return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`
}

/**
 * What restoring actually brings back, stated in the UI rather than implied.
 *
 * CLAUDE.md is explicit that cookies persist but a web app's in-memory state
 * does not, so a session that expired while the browser was shut lands on a
 * sign-in page. A resume feature that does not say so is claiming a capability
 * the engine has never had.
 */
export const RESUME_CAVEAT =
  'Pages, order and back history come back. Signed-in state is up to each site.'
