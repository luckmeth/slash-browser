import { z } from 'zod'

/**
 * Crash reporting, local only.
 *
 * These schemas live in `shared/types` rather than beside the service in
 * `src/main/`, because `shared/ipc/contracts.ts` imports them and that module is
 * consumed by the preload and the renderer. A contract importing a main-process
 * module would drag the database and `electron` into a sandboxed preload bundle —
 * the same rule that keeps every other engine's types here and its implementation
 * in main.
 */

export const CrashEventSchema = z.object({
  id: z.number().int(),
  at: z.number(),
  /** 'renderer' | 'gpu' | 'utility' | 'main' */
  process: z.string(),
  /** Chromium's own reason string: 'crashed', 'oom', 'killed', … */
  reason: z.string(),
  code: z.number().int().nullable()
})
export type CrashEvent = z.infer<typeof CrashEventSchema>

export const CrashReportSchema = z.object({
  /** Where dumps are written, so the user can find them without being told. */
  directory: z.string(),
  dumpCount: z.number().int(),
  events: z.array(CrashEventSchema),
  /**
   * Always false in this build, and reported as a value rather than assumed.
   *
   * There is no crash-reporting server. A dump contains process memory, and
   * therefore whatever was on the page, so uploading one by default would
   * contradict every other privacy claim this browser makes.
   */
  uploadsEnabled: z.boolean()
})
export type CrashReport = z.infer<typeof CrashReportSchema>
