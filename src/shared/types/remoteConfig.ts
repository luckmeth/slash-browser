import { z } from 'zod'

/**
 * Configuration the publisher of this build can change without shipping one.
 *
 * In `shared/` rather than beside the service, because `shared` may never import
 * from `main` — the renderer would then pull the whole main-process tree in.
 *
 * **Inert by default.** `remoteConfigEndpoint` is empty on a fresh install, so
 * no request is ever made and every value here is the local default. A browser
 * that asks a server how to behave on launch is doing precisely what this one is
 * sold as not doing, so it happens only when whoever built the installer set it
 * up.
 */
export const RemoteConfigSchema = z.object({
  /** Whether the start page offers the "Advertise on Slash" entry point. */
  showAdvertiseCta: z.boolean(),
  /** A message from whoever publishes this build. Empty means nothing to say. */
  notice: z.object({
    message: z.string(),
    level: z.enum(['info', 'warn', 'urgent']),
    /** https only, or empty. A link put in front of every user is not an http link. */
    url: z.string()
  }),
  /** Rollout flags. An unknown or missing flag is off. */
  flags: z.record(z.string(), z.boolean())
})
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
  showAdvertiseCta: true,
  notice: { message: '', level: 'info', url: '' },
  flags: {}
}
