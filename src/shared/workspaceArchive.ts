/**
 * Whether a workspace can be archived, and what to say when it cannot.
 *
 * Pure, because every clause here is a refusal a user will read. A control that
 * silently does nothing is indistinguishable from one that is broken, and the
 * two dangerous cases — archiving the workspace you are standing in, and
 * archiving the one that must always exist — both look like ordinary clicks
 * right up until the tabs vanish.
 */

export interface ArchiveCandidate {
  readonly id: string
  readonly name: string
  /** Non-null when it is already archived. */
  readonly archivedAt: number | null
}

export interface ArchiveContext {
  readonly workspace: ArchiveCandidate
  readonly activeWorkspaceId: string
  readonly defaultWorkspaceId: string
  /** How many of its tabs would be closed and kept. */
  readonly tabCount: number
}

/**
 * The reason this cannot be archived, or null when it can.
 *
 * Ordered by how surprising the outcome would be. The default workspace is
 * checked first because archiving it would leave a tab with nowhere to live,
 * which is a structural problem rather than a preference.
 */
export function archiveRefusal(context: ArchiveContext): string | null {
  const { workspace, activeWorkspaceId, defaultWorkspaceId, tabCount } = context

  if (workspace.id === defaultWorkspaceId) {
    return 'The default workspace cannot be archived — a tab must always have somewhere to live.'
  }
  if (workspace.id === activeWorkspaceId) {
    return 'Switch to another workspace first. Archiving the one you are in would close the tabs in front of you.'
  }
  if (workspace.archivedAt !== null) {
    return 'It is already archived.'
  }
  if (tabCount === 0) {
    return 'Nothing is open in it, so there is nothing to archive.'
  }
  return null
}

/** What archiving will do, said before it happens rather than after. */
export function archivePreview(tabCount: number): string {
  return (
    `${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'} will be saved to a restore point and closed. ` +
    'The workspace keeps its name and notes, and reopening brings the pages back with their ' +
    'scroll position and back history.'
  )
}
