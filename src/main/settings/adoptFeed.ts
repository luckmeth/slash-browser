import { UPDATE_FEED_DEFAULT } from '@shared/types/updates'
import type { Settings } from '@shared/types/settings'

/**
 * Adopting the release feed into a profile written before there was one.
 *
 * `updateFeedUrl` used to default to the empty string, and every launch saves
 * all 81 keys — so existing profiles hold `""` on disk. Changing the schema
 * default does not reach them: zod fills a `.default()` only where a key is
 * **absent**, and an explicitly stored `""` is a perfectly valid string that
 * passes straight through. The result is a browser that reports "no update
 * channel is configured" for ever, and therefore never learns about a Chromium
 * security fix. Measured on a real profile, not reasoned about: the row held
 * `updateFeedUrl: ""` while the build's own default was the GitHub feed.
 *
 * The awkward part is that an empty feed is also the **off switch** — the
 * settings copy says "empty = never check", and repopulating a field somebody
 * deliberately cleared would be overriding a privacy choice, which is the one
 * thing this browser must not do quietly.
 *
 * So adoption happens exactly once per profile, and the marker is set whether
 * or not anything was filled in. A profile that has been through this keeps
 * whatever it says next — clear the field after this has run and it stays
 * cleared, for ever. Only a profile that has never seen the question, and
 * still carries the old default, gets the new one.
 */
export interface Adoption {
  readonly settings: Settings
  /** Whether anything changed, so the caller only writes when it must. */
  readonly changed: boolean
}

export function adoptDefaultFeed(settings: Settings): Adoption {
  // Already asked and answered. Whatever the field says now is a choice.
  if (settings.updateFeedAdopted) return { settings, changed: false }

  const empty = settings.updateFeedUrl.trim() === ''

  return {
    settings: {
      ...settings,
      updateFeedUrl: empty ? UPDATE_FEED_DEFAULT : settings.updateFeedUrl,
      updateFeedAdopted: true
    },
    changed: true
  }
}
