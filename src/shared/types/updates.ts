import { z } from 'zod'

/**
 * Update checking.
 *
 * Installing is **gated on the build being code-signed**, checked against the
 * binary on this machine rather than a flag set when it was built. Unsigned, an
 * update package cannot be verified as coming from us, and an auto-installer
 * with nothing to verify against is an unauthenticated way to put code on the
 * user's machine — worse than having no updates at all.
 *
 * The install path itself is written and wired. Buying a certificate and setting
 * `CSC_LINK`/`CSC_KEY_PASSWORD` for the build is the whole of what switches it
 * on: `isSignedBuild()` starts returning true, `canInstall` follows, and the
 * button in Settings stops being disabled. No code change is involved.
 * `verifyUpdateCodeSignature` in the builder config is already on, so the
 * installer will refuse a package whose signature does not match.
 */

export const UpdateStateSchema = z.enum([
  /** No feed URL configured, so there is nothing to check against. */
  'no-channel',
  'idle',
  'checking',
  'up-to-date',
  'update-available',
  /** Fetching the package. */
  'downloading',
  /** Downloaded and verified against the published checksum, ready to run. */
  'ready',
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
  canInstall: z.boolean(),
  /**
   * Whether the feed publishes a package and a checksum for it.
   *
   * Distinct from `canInstall`, which is about this build being code-signed.
   * A feed with a checksum lets Slash fetch the package and prove it is the
   * one that was published; it does not prove who published it, which is what
   * a signature is for. The UI states both rather than conflating them.
   */
  canFetch: z.boolean().default(false),
  /** 0-1 while downloading. */
  progress: z.number().default(0),
  /** What the release says about itself, from the feed. */
  notes: z.string().default('')
})
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>
