import { z } from 'zod'

/** Preset accent colours. Stored as an id, not a hex value, so theming can change. */
export const WORKSPACE_COLORS = [
  'blue',
  'green',
  'purple',
  'amber',
  'rose',
  'teal',
  'slate'
] as const
export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number]

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  /** A single emoji. Simplest icon system that needs no assets and no CSP change. */
  icon: z.string().max(8),
  color: z.enum(WORKSPACE_COLORS),
  /**
   * Whether this workspace has its own cookie/storage partition.
   *
   * Fixed at creation and never editable. Flipping it later would strand every
   * cookie in the old partition, so the UI offers "duplicate as isolated"
   * instead of a toggle that would silently sign the user out of everything.
   */
  isolated: z.boolean(),
  notes: z.string(),
  sortOrder: z.number().int(),
  createdAt: z.number()
})
export type Workspace = z.infer<typeof WorkspaceSchema>

/**
 * The workspace every tab belongs to before the user creates any of their own.
 * It is never isolated and cannot be deleted — there must always be somewhere
 * for a tab to live.
 */
export const DEFAULT_WORKSPACE_ID = 'default'

export const WorkspacesSnapshotSchema = z.object({
  workspaces: z.array(WorkspaceSchema),
  activeWorkspaceId: z.string()
})
export type WorkspacesSnapshot = z.infer<typeof WorkspacesSnapshotSchema>
