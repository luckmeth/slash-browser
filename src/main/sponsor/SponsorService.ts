import { net } from 'electron'
import { SponsorBatchSchema, type SponsorStatus, type SponsoredTile, PLACEMENTS } from '@shared/types/sponsor'
import { acceptCreative, reportUrlFor, selectLive } from './sponsorRules'
import type { Database } from '../db/Database'
import type { SettingsStore } from '../settings/SettingsStore'
import { createLogger } from '../logger'

const log = createLogger('sponsor')

/** Refetch no more often than this, however many windows are opened. */
const MIN_FETCH_INTERVAL_MS = 6 * 60 * 60 * 1000
/** A batch is dropped after this even if the server claimed longer. */
const MAX_BATCH_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface TileRow {
  id: string
  sponsor: string
  headline: string
  body: string
  image: string
  click_url: string
  placement: string
  starts_at: number | null
  ends_at: number | null
}

/**
 * Sponsored tiles on the start page.
 *
 * This is the one place Slash shows advertising, and the shape of it is chosen
 * so that it cannot become the thing this browser blocks:
 *
 *  - **Batched, never per-impression.** Creatives are fetched ahead of time and
 *    chosen on-device. The fetch carries no identifier, no browsing data and no
 *    targeting parameters — the sponsor learns that a copy of Slash asked for
 *    tiles, and nothing about who is running it. Showing a tile makes no
 *    request at all.
 *  - **Images are inlined.** A remote `<img src>` would be a per-impression
 *    call to the sponsor's server — a tracking pixel wearing a different hat —
 *    and would undo the batching entirely. Anything that is not a `data:` URL
 *    is dropped at fetch time rather than trusted.
 *  - **Aggregate reporting only.** Impressions and clicks are counted per
 *    creative per *day*. There is deliberately no timestamp finer than that, no
 *    page, no session and no id, because that is the difference between "this
 *    creative was seen 40 times" and a record of when someone opened a tab.
 *  - **Off unless asked for, twice.** It needs both the user's switch and an
 *    operator-configured endpoint. With either missing, no request is ever made.
 */
export class SponsorService {
  private lastFetch = 0
  private rotation = 0

  constructor(
    private readonly db: Database,
    private readonly settings: SettingsStore,
    /**
     * Announces that the cached batch changed.
     *
     * Optional so every probe and test can build this without a window to
     * broadcast to. Without it the start page never learns a batch arrived —
     * see the note on the `sponsor:changed` contract.
     */
    private readonly onChanged: () => void = () => {}
  ) {}

  private get endpoint(): string {
    return this.settings.getAll().sponsorEndpoint.trim()
  }

  private get active(): boolean {
    return this.settings.getAll().sponsoredTilesEnabled && this.endpoint !== ''
  }

  /**
   * What the start page and the settings panel need to know.
   *
   * **Side-effect free.** It used to rotate the batch as it read it, which made
   * every caller advance the ad — including the click handler, which then
   * compared the clicked id against a *different* creative, failed its own
   * guard, and recorded a billable click that opened nothing. Reading state must
   * not change it; rotation is now `recordImpression`'s job, because an advert
   * having been *shown* is the thing that should move the batch on.
   */
  status(): SponsorStatus {
    const cached = this.cachedTiles()
    return {
      enabled: this.settings.getAll().sponsoredTilesEnabled,
      configured: this.endpoint !== '',
      tile: this.active ? this.currentTile(cached.filter((t) => t.placement === 'tile')) : null,
      // No rotation: the backdrop is sold exclusively, so at most one campaign
      // can be live at a time and picking "the first one due" is the whole of
      // the decision.
      background: this.active ? this.livePlacement(cached, 'background') : null,
      banner: this.active ? this.livePlacement(cached, 'banner') : null,
      notice: this.active ? this.livePlacement(cached, 'notice') : null,
      // Two slots, filled in cache order. `livePlacement` answers with one, so
      // the pair is taken directly — a rail campaign is bought as "a gutter",
      // not as "the left gutter", and which side it lands on is not sold.
      rails: this.active ? this.liveRails(cached) : [],
      cached: cached.length,
      pendingReports: this.pendingCount()
    }
  }

  /**
   * The creative currently due, without advancing.
   *
   * Round-robin rather than random, so a small batch is shown evenly instead of
   * one creative dominating by luck — which is what a sponsor is paying for.
   *
   * Campaigns outside their window are skipped here rather than dropped from
   * the cache, so one fetch can carry days of scheduling — which is what makes
   * selling an advert by the hour work against a six-hourly refresh.
   */
  private currentTile(tiles: SponsoredTile[]): SponsoredTile | null {
    return selectLive(tiles, this.rotation, Date.now())
  }

  /**
   * One cached creative by id.
   *
   * How a click resolves its destination: from our own record, by the id the
   * renderer sent, never from whatever the rotation happens to be pointing at.
   *
   * Deliberately ignores the campaign window. A click a moment after a campaign
   * ends is a click on an advert that was legitimately on screen when it was
   * pressed, and the reader should land where the tile said — not on nothing
   * because a timer turned over between the paint and the press.
   */
  /**
   * The one creative live in a placement now, or null.
   *
   * No rotation: every placement except the tile is sold with a small
   * concurrency cap, so the first one due is the whole of the decision.
   */
  /** Up to two live rail creatives, in cache order. */
  private liveRails(cached: SponsoredTile[]): SponsoredTile[] {
    const now = Date.now()
    return cached
      .filter((tile) => tile.placement === 'rail')
      .filter(
        (tile) =>
          (tile.startsAt === null || tile.startsAt <= now) &&
          (tile.endsAt === null || tile.endsAt > now)
      )
      .slice(0, 2)
  }

  private livePlacement(
    cached: SponsoredTile[],
    placement: SponsoredTile['placement']
  ): SponsoredTile | null {
    return selectLive(
      cached.filter((creative) => creative.placement === placement),
      0,
      Date.now()
    )
  }

  tileFor(id: string): SponsoredTile | null {
    return this.cachedTiles().find((tile) => tile.id === id) ?? null
  }

  private cachedTiles(): SponsoredTile[] {
    const now = Date.now()
    return this.db.connection
      .prepare<[number], TileRow>(
        `SELECT id, sponsor, headline, body, image, click_url, placement, starts_at, ends_at
           FROM sponsored_tiles WHERE expires_at > ? ORDER BY id`
      )
      .all(now)
      .map((row) => ({
        id: row.id,
        sponsor: row.sponsor,
        headline: row.headline,
        body: row.body,
        image: row.image,
        clickUrl: row.click_url,
        placement: asPlacement(row.placement),
        startsAt: row.starts_at,
        endsAt: row.ends_at
      }))
  }

  /**
   * Impressions and clicks are recorded per creative per day, nothing finer.
   *
   * Recording an impression is also what **advances the rotation**: the advert
   * has now been shown, so the next start page should get the next one. Keeping
   * it here rather than in `status()` means reading the state never changes it.
   */
  recordImpression(tileId: string): void {
    if (!this.bump(tileId, 'impressions')) return
    this.rotation += 1
  }

  recordClick(tileId: string): void {
    this.bump(tileId, 'clicks')
  }

  /**
   * @returns whether the count was recorded.
   *
   * Ids are checked against the cache first. The id arrives from the renderer,
   * and an unrecognised one would otherwise be inserted and then reported to
   * the sponsor as billing data for a creative that was never served.
   */
  private bump(tileId: string, column: 'impressions' | 'clicks'): boolean {
    if (!this.active) return false
    if (!this.tileFor(tileId)) {
      log.warn(`ignored a ${column} count for unknown creative ${tileId}`)
      return false
    }
    const day = new Date().toISOString().slice(0, 10)
    this.db.connection
      .prepare(
        `INSERT INTO sponsored_counts (tile_id, day, ${column}) VALUES (?, ?, 1)
         ON CONFLICT(tile_id, day) DO UPDATE SET ${column} = ${column} + 1`
      )
      .run(tileId, day)
    return true
  }

  private pendingCount(): number {
    const row = this.db.connection
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM sponsored_counts')
      .get()
    return row?.n ?? 0
  }

  /**
   * Fetches a fresh batch if one is due.
   *
   * Silent on failure by design: an unreachable sponsor endpoint is not the
   * user's problem and must never interrupt browsing. The previous batch keeps
   * showing until it expires, and then nothing shows.
   */
  async refresh(): Promise<void> {
    if (!this.active) return

    // Reporting runs on its own clock, BEFORE the fetch-due check.
    //
    // It used to sit inside it, which meant counts only left when a new batch
    // was due — every six hours. A browser that is never open that long would
    // have accumulated impressions forever and reported none of them, quietly
    // costing whoever sells the inventory their billing data. Caught by the
    // probe rather than in production, which is the whole reason it exists.
    //
    // Its own try/catch, because it now sits outside the one below: an
    // unreachable endpoint must not reject out of here into the floating call
    // at startup.
    try {
      await this.report()
    } catch (error) {
      log.warn('could not report sponsored-tile counts; keeping them for next time', error)
    }

    if (Date.now() - this.lastFetch < MIN_FETCH_INTERVAL_MS) return
    this.lastFetch = Date.now()

    try {
      const response = await net.fetch(this.endpoint, {
        method: 'GET',
        // No cookies, no cache, no credentials. This request must be
        // indistinguishable between one copy of Slash and the next.
        credentials: 'omit',
        cache: 'no-store',
        headers: { accept: 'application/json' }
      })
      if (!response.ok) {
        log.warn(`sponsor endpoint returned ${response.status}`)
        return
      }

      const parsed = SponsorBatchSchema.safeParse(await response.json())
      if (!parsed.success) {
        log.warn('sponsor batch did not match the documented shape; ignored')
        return
      }

      // An operator cannot extend a batch's life indefinitely by claiming a
      // distant expiry: stale advertising is a support problem, not a feature.
      const expiresAt = Math.min(parsed.data.expiresAt, Date.now() + MAX_BATCH_AGE_MS)

      // Rejection rules live in `sponsorRules` so they can be tested without
      // launching a browser — they are the rules that keep a tile from becoming
      // a tracking pixel, which makes them the ones worth pinning down.
      const accepted = parsed.data.tiles.filter((tile) => {
        const verdict = acceptCreative(tile)
        if (!verdict.ok) log.warn(`tile ${tile.id} dropped: ${verdict.reason}`)
        return verdict.ok
      })

      const write = this.db.connection.transaction(() => {
        this.db.connection.prepare('DELETE FROM sponsored_tiles').run()
        const insert = this.db.connection.prepare(
          `INSERT INTO sponsored_tiles
             (id, sponsor, headline, body, image, click_url, fetched_at, expires_at,
              starts_at, ends_at, placement)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        for (const tile of accepted) {
          insert.run(
            tile.id,
            tile.sponsor,
            tile.headline,
            tile.body,
            tile.image,
            tile.clickUrl,
            Date.now(),
            expiresAt,
            tile.startsAt,
            tile.endsAt,
            tile.placement
          )
        }
      })
      write()
      log.info(`cached ${accepted.length} sponsored tile(s)`)
      // Tell the start page. It reads status once when it mounts, and it mounts
      // at launch — long before any batch has been fetched — so without this
      // the banner and the background stayed invisible until the next restart.
      this.onChanged()
    } catch (error) {
      log.warn('could not refresh sponsored tiles', error)
    }
  }

  /**
   * Sends the aggregate counts and clears them.
   *
   * Counts are only deleted once the server has accepted them, so a failed
   * report costs a retry rather than a sponsor's billing data.
   */
  private async report(): Promise<void> {
    const rows = this.db.connection
      .prepare<[], { tile_id: string; day: string; impressions: number; clicks: number }>(
        'SELECT tile_id, day, impressions, clicks FROM sponsored_counts'
      )
      .all()
    if (rows.length === 0) return

    const reportUrl = reportUrlFor(this.endpoint)
    if (!reportUrl) return

    const response = await net.fetch(reportUrl, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      // Exactly this and nothing else. No install id, no version, no locale —
      // each of which would narrow "some copy of Slash" toward "this one".
      body: JSON.stringify({
        counts: rows.map((row) => ({
          tileId: row.tile_id,
          day: row.day,
          impressions: row.impressions,
          clicks: row.clicks
        }))
      })
    })

    if (!response.ok) {
      log.warn(`report rejected with ${response.status}; counts kept for next time`)
      return
    }
    this.db.connection.prepare('DELETE FROM sponsored_counts').run()
  }

  /** Everything this feature holds, for the user's "forget it all" button. */
  clear(): void {
    this.db.connection.prepare('DELETE FROM sponsored_tiles').run()
    this.db.connection.prepare('DELETE FROM sponsored_counts').run()
    this.lastFetch = 0
    this.onChanged()
  }
}

/**
 * A stored placement string, narrowed.
 *
 * Anything unrecognised becomes a tile. A row written by a newer build than
 * this one must degrade to the smallest, least intrusive shape rather than
 * to whatever the enum happens to list first.
 */
/**
 * A stored placement, checked against the one list of them.
 *
 * This was the **third** copy of that list — after the two schemas — and it
 * failed the same way they did: a value it had not been taught about silently
 * became `'tile'`, so rail campaigns were written correctly, read back as
 * tiles, and appeared in the wrong placement while their own slot stayed
 * empty. Nothing threw and nothing logged. Driving it from `PLACEMENTS` means
 * adding a placement is one edit, in one file.
 */
function asPlacement(value: string): SponsoredTile['placement'] {
  return (PLACEMENTS as readonly string[]).includes(value)
    ? (value as SponsoredTile['placement'])
    : 'tile'
}
