import { z } from 'zod'

/**
 * Priority state of a tab, driven by recency and activity.
 *
 * Distinct from `TabStatus` (in tab.ts), which records only whether a
 * `WebContentsView` exists. A tab can be BACKGROUND and live, or IDLE and live;
 * only HIBERNATED implies no view.
 */
export const PerformanceStateSchema = z.enum([
  /** The tab the user is looking at. Never throttled, never slept. */
  'ACTIVE',
  /** Recently active. Kept fully warm so switching back is instant. */
  'RECENT',
  /** Not recently used, but doing something — audio, download, network. */
  'BACKGROUND',
  /** Idle past the configured threshold. A candidate for freezing. */
  'IDLE',
  /** View detached from the window: no compositing, timers throttled, muted. */
  'FROZEN',
  /** View destroyed. Model retained; activating rebuilds and restores history. */
  'HIBERNATED',
  /** User-pinned as never-sleep. Orthogonal to the ladder above. */
  'PROTECTED'
])
export type PerformanceState = z.infer<typeof PerformanceStateSchema>

/**
 * Why a tab may not be slept. Surfaced verbatim in the dashboard so the answer
 * to "why is this tab still using memory?" is always visible.
 */
export const SleepBlockerSchema = z.enum([
  'active-tab',
  'playing-audio',
  'active-download',
  'user-protected',
  'unsaved-form-input',
  'has-beforeunload',
  'devtools-open',
  'already-hibernated',
  'internal-page'
])
export type SleepBlocker = z.infer<typeof SleepBlockerSchema>

export const SLEEP_BLOCKER_LABELS: Record<SleepBlocker, string> = {
  'active-tab': 'This is the tab you are using',
  'playing-audio': 'Playing audio or video',
  'active-download': 'A download is in progress',
  'user-protected': 'You marked this tab Never Sleep',
  'unsaved-form-input': 'Has text typed into a form that would be lost',
  'has-beforeunload': 'The page asks to confirm before closing',
  'devtools-open': 'Developer tools are open',
  'already-hibernated': 'Already hibernated',
  'internal-page': 'Internal page — uses no renderer'
}

export const TabMetricsSchema = z.object({
  tabId: z.string(),
  state: PerformanceStateSchema,
  /** Null when the tab has no live renderer. */
  processId: z.number().int().nullable(),
  /**
   * Whether this process serves more than one tab.
   *
   * Chromium's site isolation means several same-site tabs share a renderer, and
   * `app.getAppMetrics()` reports per **process**. When true, cpu/memory below
   * are the process total divided by the number of tabs sharing it — an estimate,
   * and the UI must say so rather than presenting it as this tab's real usage.
   */
  sharedProcess: z.boolean(),
  tabsOnProcess: z.number().int(),
  /** Percent of one core, as reported by Chromium. Null when not measurable. */
  cpuPercent: z.number().nullable(),
  /** Working set in bytes. Null when not measurable. */
  memoryBytes: z.number().nullable(),
  idleMs: z.number(),
  blockers: z.array(SleepBlockerSchema),
  /** Bytes actually freed when this tab was hibernated. Null if never slept. */
  measuredSavingsBytes: z.number().nullable()
})
export type TabMetrics = z.infer<typeof TabMetricsSchema>

export const RecommendationSchema = z.object({
  id: z.string(),
  kind: z.enum(['hibernate-idle', 'freeze-idle', 'close-duplicates']),
  title: z.string(),
  detail: z.string(),
  tabIds: z.array(z.string()),
  /**
   * Projected bytes freed. Always an estimate — it is derived from current
   * measurements of tabs that are still running, so it is labelled as such
   * everywhere it appears.
   */
  estimatedSavingsBytes: z.number()
})
export type Recommendation = z.infer<typeof RecommendationSchema>

export const PerformanceSnapshotSchema = z.object({
  tabs: z.array(TabMetricsSchema),
  recommendations: z.array(RecommendationSchema),
  /** Sum of measured savings from tabs currently hibernated. */
  totalMeasuredSavingsBytes: z.number(),
  /** Whether sampling produced usable numbers this cycle. */
  metricsAvailable: z.boolean(),
  sampledAt: z.number()
})
export type PerformanceSnapshot = z.infer<typeof PerformanceSnapshotSchema>

/** Tuning knobs. Presets map onto these rather than branching in the state machine. */
export const PerformancePolicySchema = z.object({
  mode: z.enum(['off', 'balanced', 'aggressive']),
  /** Time since last active before a tab becomes IDLE. */
  idleAfterMs: z.number().int().min(10_000),
  /** Time IDLE before freezing. */
  freezeAfterMs: z.number().int().min(10_000),
  /** Time IDLE before hibernating. 0 disables automatic hibernation. */
  hibernateAfterMs: z.number().int().min(0),
  /** Automatic actions only run above this system memory pressure (0–1). */
  memoryPressureThreshold: z.number().min(0).max(1)
})
export type PerformancePolicy = z.infer<typeof PerformancePolicySchema>

const MINUTE = 60_000

/**
 * Presets. `off` disables automatic action entirely — recommendations are still
 * produced, but nothing happens without the user pressing a button.
 */
export const POLICY_PRESETS: Record<PerformancePolicy['mode'], PerformancePolicy> = {
  off: {
    mode: 'off',
    idleAfterMs: 10 * MINUTE,
    freezeAfterMs: Number.MAX_SAFE_INTEGER,
    hibernateAfterMs: 0,
    memoryPressureThreshold: 1
  },
  balanced: {
    mode: 'balanced',
    idleAfterMs: 10 * MINUTE,
    freezeAfterMs: 20 * MINUTE,
    hibernateAfterMs: 120 * MINUTE,
    memoryPressureThreshold: 0.75
  },
  aggressive: {
    mode: 'aggressive',
    idleAfterMs: 3 * MINUTE,
    freezeAfterMs: 6 * MINUTE,
    hibernateAfterMs: 30 * MINUTE,
    memoryPressureThreshold: 0.6
  }
}
