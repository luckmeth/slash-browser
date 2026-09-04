import { DEFAULT_REMOTE_CONFIG, type RemoteConfig } from '@shared/types/remoteConfig'

/**
 * Reads the operator's key/value rows into something typed.
 *
 * Every key is optional and every malformed value falls back to its default,
 * because the far end is a table an operator edits by hand. A typo there must
 * change one thing at most — not take the start page down.
 */
export function interpretConfig(settings: Record<string, unknown>): RemoteConfig {
  const notice = settings.notice
  const noticeRecord =
    typeof notice === 'object' && notice !== null ? (notice as Record<string, unknown>) : {}

  const flagsValue = settings.feature_flags
  const flags: Record<string, boolean> = {}
  if (typeof flagsValue === 'object' && flagsValue !== null) {
    for (const [key, value] of Object.entries(flagsValue as Record<string, unknown>)) {
      if (typeof value === 'boolean') flags[key] = value
    }
  }

  const level = noticeRecord.level
  const url = typeof noticeRecord.url === 'string' ? noticeRecord.url : ''

  return {
    showAdvertiseCta:
      typeof settings.show_advertise_cta === 'boolean'
        ? settings.show_advertise_cta
        : DEFAULT_REMOTE_CONFIG.showAdvertiseCta,
    notice: {
      message: typeof noticeRecord.message === 'string' ? noticeRecord.message.slice(0, 300) : '',
      level: level === 'warn' || level === 'urgent' ? level : 'info',
      // https only. A notice is a link the publisher can put in front of every
      // user of the browser, which is not a thing to send over plain http.
      url: /^https:\/\//i.test(url) ? url : ''
    },
    flags,
    advertising: readAdvertising(settings)
  }
}

/**
 * The rate card the operator serves, falling back to the compiled defaults.
 *
 * Every field is checked rather than trusted: this is remote input rendered on
 * a page that asks companies for money, so a malformed row must degrade to the
 * built-in price rather than to an empty or nonsensical one.
 */
function readAdvertising(settings: Record<string, unknown>): RemoteConfig['advertising'] {
  const fallback = DEFAULT_REMOTE_CONFIG.advertising
  const raw = settings.advertising
  if (!raw || typeof raw !== 'object') return fallback

  const record = raw as Record<string, unknown>
  const text = (value: unknown, limit: number): string =>
    typeof value === 'string' ? value.slice(0, limit) : ''

  const rows = Array.isArray(record.placements) ? record.placements : []
  const placements = rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .map((row) => ({
      id: text(row.id, 40),
      name: text(row.name, 60),
      what: text(row.what, 200),
      concurrency: text(row.concurrency, 80),
      rate: text(row.rate, 60)
    }))
    // A row with no name or no price is not a placement anybody can buy.
    .filter((row) => row.id !== '' && row.name !== '' && row.rate !== '')

  return {
    contactEmail: text(record.contactEmail, 120) || fallback.contactEmail,
    reachNote: text(record.reachNote, 300),
    placements: placements.length > 0 ? placements : fallback.placements
  }
}
