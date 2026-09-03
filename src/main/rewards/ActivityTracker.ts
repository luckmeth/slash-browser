import type { RewardsService } from './RewardsService'
import type { SettingsStore } from '../settings/SettingsStore'
import {
  advance,
  blockersFor,
  close,
  explain,
  SAMPLE_INTERVAL_MS,
  type EarningBlocker,
  type IntervalState
} from './earningRules'

/** What the tracker needs to know about the browser at this instant. */
export interface ActivitySample {
  focused: boolean
  url: string
  privateWindow: boolean
  /**
   * From `powerMonitor.getSystemIdleTime()`, read by the caller.
   *
   * Injected rather than read here so this module imports nothing from
   * `electron` and can be unit-tested — `npm test` is pure logic only, and a
   * path that decides who gets paid should not be the one part of the feature
   * that is only ever exercised by running a browser.
   */
  idleSeconds: number
}

/**
 * Turns moments of qualifying browsing into closed intervals.
 *
 * The timer is the only thing here; every decision lives in `earningRules`,
 * which is pure and tested. That split is deliberate — a fraud control that can
 * only be exercised by running a browser for six hours is a fraud control
 * nobody will ever check.
 *
 * The sampling cost is one `getSystemIdleTime` and one property read every
 * thirty seconds, and the timer is unrefed so it can never hold the process
 * open. It does not run at all until the user has switched Slash Coin on.
 */
export class ActivityTracker {
  private timer: NodeJS.Timeout | null = null
  private open: IntervalState | null = null
  private lastBlockers: EarningBlocker[] = ['rewards-off']

  constructor(
    private readonly read: () => ActivitySample,
    private readonly rewards: RewardsService,
    private readonly settings: SettingsStore,
    private readonly onChanged: () => void
  ) {}

  get earning(): boolean {
    return this.lastBlockers.length === 0
  }

  get note(): string {
    return explain(this.lastBlockers)
  }

  /** Called at launch and whenever the setting changes. */
  sync(): void {
    if (this.settings.getAll().rewardsEnabled) this.start()
    else this.stop()
  }

  private start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS)
    this.timer.unref()
    // Once immediately, so the reason shown on screen is true from the first
    // paint. Waiting for the first tick left `lastBlockers` at its initial
    // `rewards-off`, and the rewards page said "Slash Coin is switched off"
    // directly underneath a sign-in button - for thirty seconds, on the screen
    // that exists to explain the feature.
    this.sample()
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Bank whatever was open rather than discarding it: switching the feature
    // off should not cost somebody the half hour they had already earned.
    this.flush()
    this.lastBlockers = ['rewards-off']
  }

  private sample(): void {
    const now = Date.now()
    const activity = this.read()
    const blockers = blockersFor({
      enabled: this.settings.getAll().rewardsEnabled,
      earningActive: this.rewards.earningActive,
      signedIn: this.rewards.signedIn,
      profileComplete: this.rewards.profileComplete,
      focused: activity.focused,
      idleSeconds: activity.idleSeconds,
      url: activity.url,
      privateWindow: activity.privateWindow,
      secondsEarnedToday: this.rewards.secondsToday,
      dailyCapSeconds: this.rewards.dailyCapSeconds
    })

    const wasEarning = this.lastBlockers.length === 0
    this.lastBlockers = blockers

    const result = advance(this.open, { at: now, qualifying: blockers.length === 0 })
    this.open = result.state
    if (result.closed) this.rewards.record(result.closed)

    void this.rewards.report()
    if (wasEarning !== (blockers.length === 0)) this.onChanged()
  }

  /** Closes and records whatever is open. Called on quit and when switched off. */
  flush(): void {
    if (!this.open) return
    const closed = close(this.open)
    this.open = null
    if (closed) this.rewards.record(closed)
  }

  dispose(): void {
    this.flush()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
