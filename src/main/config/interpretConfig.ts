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
    flags
  }
}
