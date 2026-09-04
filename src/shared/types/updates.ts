import { z } from 'zod'

/**
 * Where a stock build looks for a newer version.
 *
 * A `latest.json` asset on the **public releases repository**. GitHub resolves
 * `releases/latest/download/<asset>` to the newest release, so publishing is
 * the whole of publishing: tag, and every browser finds it on its next check.
 * No database, no deployment, and no secret anywhere in the path a user takes.
 *
 * The repository holding the code is private; this one holds nothing but
 * installers and their checksums, which have to be public for an updater to
 * reach them at all. A private release asset is not downloadable without
 * credentials, and this browser carries none — it would fail silently on every
 * machine, which is the worst way for an update system to be broken.
 *
 * The request carries no identifier and no key, and the answer is identical
 * for every caller, so a check cannot be used to count installations.
 * Emptying `updateFeedUrl` in Settings stops it entirely.
 *
 * The shape of that file is pinned by `updatePlan.test.ts` against the
 * workflow that writes it, so the two cannot drift apart quietly.
 */
export const UPDATE_FEED_DEFAULT =
  'https://github.com/luckmeth/slash-releases/releases/latest/download/latest.json'

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
