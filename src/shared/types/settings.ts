import { z } from 'zod'

/**
 * Application settings. This schema is also the persistence format and the
 * migration target — `SettingsStore` parses whatever is on disk through it, so
 * adding a key with a default is a backward-compatible change.
 *
 * The privacy gates below are declared in Phase 0 deliberately, long before the
 * engines that read them exist. Later phases must check these flags rather than
 * introduce their own, which makes it structurally impossible for Web Memory or
 * the AI layer to ship an implicit default-on path.
 */
export const SettingsSchema = z.object({
  // --- Phase 1: core browser -------------------------------------------------
  searchEngineId: z.enum(['duckduckgo', 'google', 'bing', 'startpage']).default('duckduckgo'),
  homepage: z.string().default('app://newtab'),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  restoreTabsOnStartup: z.boolean().default(true),
  /** Ask before running a downloaded file with an executable extension. */
  warnOnExecutableDownload: z.boolean().default(true),
  /**
   * Whether ordinary browsing history is recorded at all.
   *
   * Distinct from `indexHistory` below: this governs the plain
   * back-of-the-browser history list, whereas `indexHistory` governs whether
   * that history is additionally fed to the Phase 5 searchable memory index.
   * Turning this off means nothing is written in the first place.
   */
  recordHistory: z.boolean().default(true),
  /** Empty = the OS default downloads folder. */
  downloadDirectory: z.string().default(''),
  /** Prompt for a save location on every download instead of using the folder above. */
  askWhereToSaveDownloads: z.boolean().default(false),

  // --- Phase 3: performance --------------------------------------------------
  performanceMode: z.enum(['off', 'balanced', 'aggressive']).default('balanced'),

  // --- Phase 6: time machine -------------------------------------------------
  /** Keep automatic restore points for this many days. 0 = keep only manual ones. */
  snapshotRetentionDays: z.number().int().min(0).max(365).default(14),
  /**
   * Include Chromium's page state in snapshots.
   *
   * Off by default and deliberately so: page state carries **form values** as
   * well as scroll position, so enabling this writes whatever has been typed
   * into a form — potentially a half-entered password — into the local database.
   * Scroll position is captured separately and is unaffected by this setting.
   */
  restoreFormState: z.boolean().default(false),

  // --- Phase 5: web memory privacy gates (default OFF) -----------------------
  /** Index visit metadata (url, title, timestamp). */
  indexHistory: z.boolean().default(false),
  /** Index extracted page *text*. Separate, stricter gate than indexHistory. */
  indexPageContent: z.boolean().default(false),
  /** Origins never indexed, regardless of the flags above. */
  excludedOrigins: z.array(z.string()).default([]),
  /** Days to retain indexed content. 0 = forever. */
  memoryRetentionDays: z.number().int().min(0).default(90),
  /** Opt-in local ONNX embedding layer. Keyword search works without it. */
  semanticSearchEnabled: z.boolean().default(false),

  // --- Phase 7: AI (default OFF, no provider configured) ---------------------
  aiProvider: z.enum(['none', 'anthropic', 'openai-compatible']).default('none'),
  /** Never sent to the renderer; the main process substitutes a redaction marker. */
  aiModel: z.string().default('claude-sonnet-5'),
  /** Page *content* may only reach a provider with a per-request approval too. */
  aiMayReadPageContent: z.boolean().default(false)
})

export type Settings = z.infer<typeof SettingsSchema>

/** Every key has a `.default()`, so parsing `{}` yields the full default object. */
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

/** Keys the renderer is allowed to write. Anything else is rejected by the handler. */
export const WRITABLE_SETTING_KEYS = Object.keys(SettingsSchema.shape) as (keyof Settings)[]
