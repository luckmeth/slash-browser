import { z } from 'zod'

/**
 * Syncing bookmarks and the reading list.
 *
 * End-to-end encrypted: the server holds ciphertext and a timestamp and nothing
 * else. The passphrase never leaves the machine and no key derived from it is
 * stored — which is why forgetting it means the synced data is unrecoverable,
 * and why the settings copy says so before anyone turns this on.
 *
 * History is deliberately not synced. It is the largest and most revealing
 * thing the browser holds, and shipping it to a server — even encrypted — is a
 * different promise from the one this browser makes.
 */
export const SyncStatusSchema = z.object({
  enabled: z.boolean(),
  /** Whether an endpoint is set at all. Without one, nothing is ever contacted. */
  configured: z.boolean(),
  /** Whether a passphrase has been entered this session. */
  unlocked: z.boolean(),
  /** This machine's identifier. Random, and not derived from anything about the user. */
  deviceId: z.string(),
  lastSyncAt: z.number().nullable(),
  lastError: z.string().nullable(),
  /** How many items this machine would offer. */
  itemCount: z.number().int()
})
export type SyncStatus = z.infer<typeof SyncStatusSchema>
