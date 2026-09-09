import { createHmac } from 'node:crypto'

/**
 * History as a sync collection.
 *
 * This reverses an earlier decision, and the reason it was made is still true:
 * history is the largest and most revealing thing the browser holds. So the
 * three problems that made it a bad candidate are solved here explicitly rather
 * than waved past — identity, volume, and counters.
 *
 * ## Identity must not leak the URL
 *
 * `docs/sync.md` already concedes that reading-list items travel under their own
 * URL as an id, because the table has no other stable key. That is a small leak
 * for a handful of saved articles and an unacceptable one for every page a
 * person has visited: a server holding plaintext history URLs is the exact
 * outcome end-to-end encryption exists to prevent.
 *
 * A plain `sha256(url)` does **not** fix it. URLs are low-entropy and public —
 * anyone can hash the top million sites once and look every id up. So the id is
 * an **HMAC under the sync key**, which the server never has. Same URL on two of
 * your devices produces the same id, because both derived the same key from the
 * same passphrase; the same URL on someone else's account produces a different
 * one; and a server cannot go from id back to URL at all.
 *
 * ## Volume must be bounded
 *
 * Bookmarks are hundreds of rows. History is tens of thousands, and `localItems`
 * encrypts every item it returns on every sync. `selectSyncable` therefore
 * applies a retention window *and* a hard cap, and both are chosen before any
 * encryption happens.
 *
 * ## Counters must not be summed
 *
 * `visit_count` is the trap. Adding the two sides makes the number grow on every
 * sync — the classic distributed-counter bug — and it grows fastest for the
 * pages you visit most, so it corrupts exactly the data that ordering depends
 * on. Visit counts are therefore **local and never synced**; what travels is the
 * URL, the title and the last visit time. `mergeVisit` takes the later visit and
 * leaves each device's own count alone.
 */

/** Days of history offered to sync. Older entries stay on the machine. */
export const HISTORY_RETENTION_DAYS = 90

/**
 * Hard cap on entries per sync.
 *
 * A retention window alone is not a bound — somebody who browses heavily can
 * produce tens of thousands of rows inside ninety days, and every one would be
 * encrypted on every pass. The cap keeps the cost of a sync predictable
 * regardless of how the browser is used.
 */
export const HISTORY_MAX_ITEMS = 5_000

export interface HistoryRow {
  readonly url: string
  readonly title: string
  readonly faviconUrl: string | null
  readonly lastVisitedAt: number
}

export interface HistoryPayload {
  readonly url: string
  readonly title: string
  readonly faviconUrl: string | null
  readonly lastVisitedAt: number
}

/**
 * The opaque id a history entry travels under.
 *
 * HMAC-SHA256 keyed with the sync key, hex. Deterministic for a given key and
 * URL — which is what lets two devices recognise the same page — and useless to
 * anyone without the key.
 */
export function historyItemId(key: Buffer, url: string): string {
  return createHmac('sha256', key).update(url, 'utf8').digest('hex')
}

/**
 * Which history rows are worth offering, newest first.
 *
 * Pure and clock-injected, because "the last ninety days" is a claim about time
 * and a test that cannot move the clock cannot check it.
 */
export function selectSyncable(
  rows: readonly HistoryRow[],
  now: number,
  options: { retentionDays?: number; maxItems?: number } = {}
): HistoryRow[] {
  const retentionDays = options.retentionDays ?? HISTORY_RETENTION_DAYS
  const maxItems = options.maxItems ?? HISTORY_MAX_ITEMS
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000

  return rows
    .filter((row) => row.lastVisitedAt >= cutoff)
    // Newest first, so the cap keeps the most recent rather than an arbitrary
    // slice — being cut off should cost you the oldest pages, not random ones.
    .slice()
    .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
    .slice(0, maxItems)
}

/**
 * What to write when a remote entry arrives for a page this device also knows.
 *
 * Returns `null` when the local row is already at least as new, so an unchanged
 * entry costs no write. Never touches `visit_count`: see the note above.
 */
export function mergeVisit(
  local: HistoryRow | null,
  remote: HistoryPayload
): HistoryPayload | null {
  if (!local) return remote
  if (local.lastVisitedAt >= remote.lastVisitedAt) return null
  return {
    url: remote.url,
    // A device that has the page but no title yet should not lose the one it
    // already had to an emptier record.
    title: remote.title.trim() !== '' ? remote.title : local.title,
    faviconUrl: remote.faviconUrl ?? local.faviconUrl,
    lastVisitedAt: remote.lastVisitedAt
  }
}

/**
 * Whether a decrypted payload is really a history entry.
 *
 * The payload arrives from a server. It is authenticated — AES-GCM will not
 * decrypt something that was tampered with — but "authentic" only means it came
 * from a device holding the key, not that it holds the fields this version
 * expects. An older or newer client writing a different shape must be skipped,
 * not written into the history table.
 */
export function isHistoryPayload(value: unknown): value is HistoryPayload {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.url === 'string' &&
    candidate.url !== '' &&
    typeof candidate.title === 'string' &&
    typeof candidate.lastVisitedAt === 'number' &&
    Number.isFinite(candidate.lastVisitedAt) &&
    (candidate.faviconUrl === null || typeof candidate.faviconUrl === 'string')
  )
}
