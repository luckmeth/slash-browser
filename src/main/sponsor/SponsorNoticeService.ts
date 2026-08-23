import type { SponsoredTile } from '@shared/types/sponsor'
import type { SettingsStore } from '../settings/SettingsStore'
import type { SponsorService } from './SponsorService'
import { DEFAULT_LIMITS, EMPTY_CADENCE, mayShowNotice, recordShown } from './noticeCadence'
import { createLogger } from '../logger'

const log = createLogger('sponsor-notice')

/** How often the cadence is even considered. Cheap: usually it says no. */
const TICK_MS = 60_000

interface WindowLike {
  readonly isPrivate?: boolean
  showSponsorNotice: (creative: SponsoredTile) => void
  readonly tabs: { snapshot: () => { activeTabId: string | null } }
}

/**
 * The advert that appears while somebody is browsing.
 *
 * **It is drawn in the browser's own chrome and never inside a web page.** That
 * distinction is the whole feature. Injecting adverts into pages is precisely
 * what Slash Shield blocks on the user's behalf; doing it ourselves would make
 * this product adware, would require scripting every site somebody visits, and
 * would be the end of any claim the browser makes about advertising. So this
 * renders in the overlay — the browser's own surface, above the page but not
 * *in* it, non-modal, and dismissible.
 *
 * It is also rare on purpose. `noticeCadence` caps it at three a day, half an
 * hour apart, with five minutes of quiet after launch. Those numbers are a
 * decision about what the product is rather than a dial to turn when revenue is
 * low: the browser blocks other people's interruptions, and ours has to be
 * infrequent enough that showing one is not hypocrisy.
 *
 * Never in a private window — the whole point of one is that nothing is
 * accumulating, and being advertised at is a poor fit for that promise.
 */
export class SponsorNoticeService {
  private timer: NodeJS.Timeout | null = null
  private readonly launchedAt = Date.now()

  constructor(
    private readonly settings: SettingsStore,
    private readonly sponsor: SponsorService,
    private readonly focusedWindow: () => WindowLike | null
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    const settings = this.settings.getAll()
    if (!settings.sponsoredTilesEnabled || !settings.sponsoredNoticesEnabled) return

    const window = this.focusedWindow()
    // Only when the browser is in front. A notice fired at a minimised window
    // burns one of the day's three on nobody.
    if (!window || window.isPrivate) return

    // Only while actually browsing. On the start page there is already a
    // sponsored surface, and two adverts on one screen is the thing this
    // browser exists to spare people.
    if (window.tabs.snapshot().activeTabId === null) return

    const state = settings.sponsorNoticeState ?? EMPTY_CADENCE
    const now = Date.now()
    const verdict = mayShowNotice(state, now, this.launchedAt, DEFAULT_LIMITS)
    if (!verdict.show) return

    const creative = this.sponsor.status().notice
    if (!creative) return

    // Recorded before showing, and persisted: restarting the browser must not
    // be a way to see more of them.
    this.settings.update({ sponsorNoticeState: recordShown(state, now) })
    window.showSponsorNotice(creative)
    log.info(`showed sponsored notice ${creative.id}`)
  }
}
