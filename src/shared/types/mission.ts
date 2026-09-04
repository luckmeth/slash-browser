import { z } from 'zod'

/**
 * Browser Mission Mode.
 *
 * A goal the user states — "finish my research paper", "complete my university
 * application" — and the pages, notes and digressions that gather around it.
 *
 * **It never blocks anything.** When a page looks unrelated it offers to save it
 * for later; that is the whole intervention. A browser that refuses to open a
 * page because the user declared a goal an hour ago is a browser they will turn
 * the feature off in, and probably distrust afterwards.
 */

export const MissionItemSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  title: z.string(),
  /** 'page' belongs to the mission; 'saved' is the for-later pile. */
  kind: z.enum(['page', 'saved']),
  addedAt: z.number()
})
export type MissionItem = z.infer<typeof MissionItemSchema>

export const MissionSchema = z.object({
  id: z.number().int(),
  goal: z.string(),
  notes: z.string(),
  active: z.boolean(),
  createdAt: z.number(),
  completedAt: z.number().nullable(),
  pages: z.array(MissionItemSchema),
  saved: z.array(MissionItemSchema)
})
export type Mission = z.infer<typeof MissionSchema>

export const MissionStatusSchema = z.object({
  /** The mission in progress, or null. Exactly one may be active. */
  active: MissionSchema.nullable(),
  /** Finished missions, most recent first, as a record of what was done. */
  past: z.array(MissionSchema),
  /**
   * Suggestion for the page the user is looking at, or null.
   *
   * Null the overwhelming majority of the time, by design: the prompt only earns
   * attention if it is rare.
   */
  suggestion: z.string().nullable()
})
export type MissionStatus = z.infer<typeof MissionStatusSchema>
