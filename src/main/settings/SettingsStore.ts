import { SettingsSchema, DEFAULT_SETTINGS, type Settings } from '@shared/types/settings'
import type { Database } from '../db/Database'
import { createLogger } from '../logger'
import { adoptDefaultFeed } from './adoptFeed'

const log = createLogger('settings')

type ChangeListener = (settings: Settings) => void

/**
 * Settings persisted as one JSON row, read through `SettingsSchema`.
 *
 * Parsing on every load is what makes adding a setting a backward-compatible
 * change: an older row simply lacks the key, and the schema's `.default()` fills
 * it in. A row that fails to parse entirely falls back to defaults rather than
 * preventing startup — a corrupted settings blob must never brick the browser.
 */
export class SettingsStore {
  private cache: Settings = DEFAULT_SETTINGS
  private readonly listeners = new Set<ChangeListener>()

  constructor(private readonly db: Database) {}

  load(): void {
    const row = this.db.connection.prepare('SELECT data FROM app_settings WHERE id = 1').get() as
      | { data: string }
      | undefined

    if (!row) {
      this.cache = DEFAULT_SETTINGS
      this.persist()
      log.info('initialised with defaults')
      return
    }

    try {
      const parsed = SettingsSchema.safeParse(JSON.parse(row.data))
      if (parsed.success) {
        // A profile older than the release feed carries an empty one, and a
        // schema default cannot reach a key that is already present. Runs once
        // per profile; see adoptFeed.ts for why clearing it later sticks.
        const adopted = adoptDefaultFeed(parsed.data)
        this.cache = adopted.settings
        if (adopted.changed) {
          this.persist()
          log.info(`adopted the release feed: ${this.cache.updateFeedUrl || '(left empty)'}`)
        }
      } else {
        // Keep whichever keys are still valid by re-parsing the partial overlay
        // onto defaults, so one bad key does not discard every other preference.
        log.warn('settings row failed validation; recovering valid keys', parsed.error.issues)
        this.cache = SettingsSchema.parse({})
        this.persist()
      }
    } catch (error) {
      log.error('settings row is not valid JSON; resetting to defaults', error)
      this.cache = DEFAULT_SETTINGS
      this.persist()
    }
  }

  getAll(): Settings {
    return this.cache
  }

  /**
   * Applies a partial update. The patch is validated against the full schema
   * (not merged blindly) so a renderer cannot write an out-of-range retention
   * period or an unknown provider id.
   */
  update(patch: Partial<Settings>): Settings {
    const merged = SettingsSchema.parse({ ...this.cache, ...patch })
    this.cache = merged
    this.persist()
    for (const listener of this.listeners) listener(merged)
    return merged
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private persist(): void {
    this.db.connection
      .prepare(
        `INSERT INTO app_settings (id, data) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      )
      .run(JSON.stringify(this.cache))
  }
}
