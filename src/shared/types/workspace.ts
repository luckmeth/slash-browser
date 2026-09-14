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

/**
 * Workspace icons, as names into the app's own SVG set.
 *
 * Deliberately not emoji. Emoji render differently on every platform and font,
 * sit at the wrong optical weight next to real UI icons, and read as informal in
 * application chrome. A fixed set also means the picker cannot produce something
 * that looks broken.
 */
export const WORKSPACE_ICONS = [
  'wsHome',
  'wsWork',
  'wsStudy',
  'wsCode',
  'wsResearch',
  'wsTravel',
  'wsShop',
  'wsMedia',
  'wsDesign',
  'wsReading',
  'wsFinance',
  'wsFolder'
] as const
export type WorkspaceIcon = (typeof WORKSPACE_ICONS)[number]

export const DEFAULT_WORKSPACE_ICON: WorkspaceIcon = 'wsFolder'

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  /**
   * Name of an icon in the app's SVG set. Unknown values (including emoji left
   * over from before this was a fixed set) fall back rather than rendering as a
   * missing glyph.
   */
  icon: z.enum(WORKSPACE_ICONS).catch(DEFAULT_WORKSPACE_ICON),
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
  createdAt: z.number(),
  /**
   * When this workspace was archived, or null while it is in use.
   *
   * An archived workspace keeps its name and notes and has no tabs open. Its
   * pages live in the restore point named below, which is the existing snapshot
   * system rather than a second store — so "restore this workspace" and
   * "restore this session" are the same mechanism.
   */
  archivedAt: z.number().nullable().default(null),
  /** The restore point holding what was open when it was archived. */
  archiveSnapshotId: z.number().int().nullable().default(null)
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
