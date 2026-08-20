import { z } from 'zod'
import { WORKSPACE_COLORS } from './workspace'

/**
 * A coloured run of tabs inside one workspace.
 *
 * Deliberately *not* a small workspace. A workspace owns a session partition and
 * decides which tabs exist at all; a group is presentation over tabs that are
 * already in a workspace — a name and a colour on a run of them. That is why
 * deleting a group never deletes tabs, and why moving a tab between groups
 * cannot reload it the way crossing an isolation boundary must.
 */
export const TabGroupSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  /** Shares the workspace palette, so a theme change repaints both. */
  color: z.enum(WORKSPACE_COLORS),
  /**
   * Hides the group's tabs in the strip.
   *
   * Collapsing is *not* sleeping. The tabs keep their views, keep loading and
   * keep playing audio; only the strip stops drawing them. Conflating the two
   * would make a visual tidy-up silently destroy renderer state.
   */
  collapsed: z.boolean(),
  createdAt: z.number()
})
export type TabGroup = z.infer<typeof TabGroupSchema>
