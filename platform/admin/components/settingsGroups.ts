/**
 * Which settings exist, and which group each belongs in.
 *
 * A plain module with no directive, so **both sides may import it**. That is
 * the whole reason it exists: `groupOf` lived in the client catalogue and the
 * server pages called it, which React refuses just as firmly as it refuses a
 * function passed the other way — "Attempted to call groupOf() from the server
 * but groupOf is on the client". One boundary mistake replaced by another,
 * found in `operations.log` again.
 *
 * The rule this encodes: a `'use client'` module may export **components** for
 * a server component to render, and nothing a server component calls.
 */

export const PLATFORM_GROUPS = ['Payments', 'Scheduling and contact'] as const
export const BROWSER_GROUPS = ['Start page', 'Rollout'] as const

/** Setting key to the group it is shown under. */
const PLATFORM_OF: Record<string, string> = {
  stripe_mode: 'Payments',
  stripe_publishable_key: 'Payments',
  currency: 'Payments',
  min_lead_time_hours: 'Scheduling and contact',
  support_email: 'Scheduling and contact'
}

const BROWSER_OF: Record<string, string> = {
  show_advertise_cta: 'Start page',
  notice: 'Start page',
  feature_flags: 'Rollout'
}

/**
 * The group a key belongs in, or null for one nobody has described.
 *
 * Null is not a failure: it routes the row to the JSON box, so a setting added
 * to the database tomorrow is editable today rather than invisible.
 */
export function groupOf(target: 'platform' | 'browser', key: string): string | null {
  const table = target === 'platform' ? PLATFORM_OF : BROWSER_OF
  return table[key] ?? null
}
