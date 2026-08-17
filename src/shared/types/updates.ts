import { z } from 'zod'

/**
 * Update checking.
 *
 * Deliberately **check-only**. Downloading and installing an update is not
 * offered, and that is a security decision rather than an unfinished one: this
 * build is not code-signed, so an update package cannot be verified as coming
 * from us. An unsigned auto-installer is an unauthenticated way to put code on
 * the user's machine, which is worse than having no updates at all.
 *
 * So the browser tells you a newer version exists and where to get it. The
 * moment a signing certificate exists, `installUpdate` becomes the small
 * addition it should be — and `verifyUpdateCodeSignature` in the builder config
 * is already on, so it will refuse a package that does not match.
 */

export const UpdateStateSchema = z.enum([
  /** No feed URL configured, so there is nothing to check against. */
  'no-channel',
  'idle',
  'checking',
  'up-to-date',
  'update-available',
  'error'
])
export type UpdateState = z.infer<typeof UpdateStateSchema>

export const UpdateStatusSchema = z.object({
  state: UpdateStateSchema,
  /** The running version. */
  currentVersion: z.string(),
  /** The newest version the feed advertises, when one was found. */
  latestVersion: z.string().nullable(),
  /** Where the user can get it. Opened in a tab; never downloaded silently. */
  releaseUrl: z.string().nullable(),
  /** When the last check completed, epoch ms. */
  checkedAt: z.number().nullable(),
  /** Plain-language account of the state. Always set. */
  detail: z.string(),
  /**
   * Whether this build could install an update even if one were found.
   *
   * False while unsigned. Reported so the UI states the real constraint instead
   * of offering a button that would refuse.
   */
  canInstall: z.boolean()
})
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>
