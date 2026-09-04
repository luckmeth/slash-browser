import { net } from 'electron'
import { z } from 'zod'
import { DEFAULT_REMOTE_CONFIG, type RemoteConfig } from '@shared/types/remoteConfig'
import type { SettingsStore } from '../settings/SettingsStore'
import { interpretConfig } from './interpretConfig'
import { createLogger } from '../logger'

const log = createLogger('remote-config')

/** Refetch no more often than this, however many windows open. */
const MIN_FETCH_INTERVAL_MS = 60 * 60 * 1000

const ConfigSchema = z.object({
  expiresAt: z.number().optional(),
  settings: z.record(z.string(), z.unknown())
})

/**
 * Configuration the publisher of this build can change without shipping one.
 *
 * **Inert by default.** `remoteConfigEndpoint` is empty on a fresh install, so
 * no request is ever made and every value is the local default. That matters:
 * a browser that phones home on launch to ask how to behave is doing exactly
 * what this one is sold as not doing, so it only happens when whoever built the
 * installer configured it.
 *
 * The request carries nothing — no identifier, no version, no locale. Each of
 * those would narrow "some copy of Slash" towards "this one", and the whole
 * response is identical for every caller anyway.
 *
 * Every failure resolves to the defaults rather than to an error the user sees.
 * An unreachable config server is not the user's problem, and a browser that
 * refuses to draw its start page because it could not ask permission would be
 * absurd.
 */
export class RemoteConfigService {
  private cached: RemoteConfig = DEFAULT_REMOTE_CONFIG
  private lastFetch = 0

  constructor(
    private readonly settings: SettingsStore,
    private readonly onChanged: (config: RemoteConfig) => void
  ) {}

  private get endpoint(): string {
    return this.settings.getAll().remoteConfigEndpoint.trim()
  }

  /** What the renderer reads. Always answers; never waits on the network. */
  current(): RemoteConfig {
    return this.endpoint === '' ? DEFAULT_REMOTE_CONFIG : this.cached
  }

  async refresh(): Promise<void> {
    if (this.endpoint === '') return
    if (Date.now() - this.lastFetch < MIN_FETCH_INTERVAL_MS) return
    this.lastFetch = Date.now()

    try {
      const response = await net.fetch(this.endpoint, {
        method: 'GET',
        // No cookies and no credentials: this request must be indistinguishable
        // between one copy of Slash and the next.
        credentials: 'omit',
        cache: 'no-store',
        headers: { accept: 'application/json' }
      })
      if (!response.ok) {
        log.warn(`remote config returned ${response.status}`)
        return
      }

      const parsed = ConfigSchema.safeParse(await response.json())
      if (!parsed.success) {
        log.warn('remote config did not match the documented shape; ignored')
        return
      }

      const next = interpretConfig(parsed.data.settings)
      const changed = JSON.stringify(next) !== JSON.stringify(this.cached)
      this.cached = next
      if (changed) this.onChanged(next)
      log.info('remote config refreshed')
    } catch (error) {
      // Keeps whatever was cached, which on a first run is the defaults.
      log.warn('could not reach the remote config endpoint', error)
    }
  }
}
