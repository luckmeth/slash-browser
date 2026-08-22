import { z } from 'zod'

/**
 * One entry in a tab's back/forward list.
 *
 * `pageState` is Chromium's opaque blob holding scroll position **and form
 * values**. It is omitted unless the user turns on `restoreFormState`, because
 * writing it would persist whatever was typed into a form — including a
 * half-entered password — to a plaintext database. Scroll position is captured
 * separately, since that carries no such risk.
 */
export const NavigationEntrySchema = z.object({
  url: z.string(),
  title: z.string(),
  pageState: z.string().optional()
})
export type NavigationEntrySnapshot = z.infer<typeof NavigationEntrySchema>

export const SnapshotTabSchema = z.object({
  url: z.string(),
  title: z.string(),
  faviconUrl: z.string().nullable(),
  workspaceId: z.string(),
  order: z.number().int(),
  isPinned: z.boolean(),
  /**
   * Which tab group this tab was in.
   *
   * Carried so restoring a session brings back the arrangement and not only the
   * pages — a restored window of ungrouped tabs loses exactly the work the user
   * put in by hand.
   */
  groupId: z.string().nullable().default(null),
  /**
   * Which window this tab was in, counting from zero.
   *
   * Defaults to 0 so snapshots written before windows were recorded restore as
   * the single window they in fact were. Indices need not be contiguous: a
   * private window occupies none, because private windows are never recorded.
   */
  windowIndex: z.number().int().min(0).default(0),
  scrollY: z.number(),
  /** Full back/forward list, so the Back button survives a restore. */
  entries: z.array(NavigationEntrySchema),
  activeEntryIndex: z.number().int()
})
export type SnapshotTab = z.infer<typeof SnapshotTabSchema>

export const SnapshotKindSchema = z.enum([
  /** Written on a timer and at clean quit. */
  'automatic',
  /** A named restore point the user asked for. */
  'manual',
  /** Written at quit specifically for the next launch. */
  'session-end'
])
export type SnapshotKind = z.infer<typeof SnapshotKindSchema>

export const SnapshotSchema = z.object({
  id: z.number().int(),
  label: z.string(),
  kind: SnapshotKindSchema,
  createdAt: z.number(),
  tabCount: z.number().int(),
  workspaceCount: z.number().int()
})
export type Snapshot = z.infer<typeof SnapshotSchema>

export const SnapshotDetailSchema = SnapshotSchema.extend({
  tabs: z.array(SnapshotTabSchema)
})
export type SnapshotDetail = z.infer<typeof SnapshotDetailSchema>

/** How often automatic snapshots are taken. */
export const AUTO_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000
