'use client'

import { groupOf } from './settingsGroups'
import {
  BooleanSetting,
  ChoiceSetting,
  FlagsSetting,
  NoticeSetting,
  NumberSetting,
  RawSetting,
  TextSetting
} from './SettingField'

/**
 * Everything known about each setting, on the client side of the boundary.
 *
 * This module exists because of a defect that took the settings page down
 * completely and was invisible to `next build`, to both typechecks and to the
 * tests: the page passed `after={(typed) => …}` — a **function** — from a
 * server component to a client component, and React refuses that. Every
 * request to `/settings` threw before rendering a thing.
 *
 * It was invisible because the page is `force-dynamic`: nothing renders it at
 * build time, so the build passed. It only appears when somebody signed in
 * asks for the page, and then only in the server log. Measured rather than
 * guessed at, in the end: `platform_settings.updated_by` was still null for
 * every row while `coin_config` — the one screen with no function props — had
 * been written that afternoon.
 *
 * The fix is structural rather than careful. Everything about a setting that
 * *cannot* cross the boundary — a hint computed from what has just been typed,
 * a warning that depends on the value — now lives here, on the client side,
 * keyed by the setting name. A page passes a string and a value. There is no
 * longer a place to put a function.
 */

interface Described {
  label: string
  why: React.ReactNode
}

const PLATFORM: Record<string, Described> = {
  stripe_mode: {
    label: 'Stripe mode',
    why: 'A label for your own benefit. What actually decides whether real money moves is which secret key is set in the host environment — this does not switch it.'
  },
  stripe_publishable_key: {
    label: 'Stripe publishable key',
    why: 'Safe to be public: it identifies your Stripe account and authorises nothing. The secret key is deliberately not here — see the note at the foot of this page.'
  },
  currency: {
    label: 'Currency',
    why: 'What prices are quoted and charged in. Changing it does not convert existing prices — it relabels them.'
  },
  min_lead_time_hours: {
    label: 'Minimum lead time',
    why: 'How far ahead of now a campaign is allowed to start. Browsers collect adverts every six hours, so anything under about 12 will not reach most readers before it is already running.'
  },
  support_email: {
    label: 'Support email',
    why: 'Shown on the public site as a way to ask a question before signing up. Empty removes it from the page rather than showing an empty link.'
  }
}

const BROWSER: Record<string, Described> = {
  show_advertise_cta: {
    label: 'Offer “Advertise on Slash”',
    why: 'Whether the start page offers the entry point to the advertising portal. Off removes the link; it does not stop campaigns running.'
  },
  notice: { label: 'Start-page notice', why: '' },
  feature_flags: { label: 'Rollout flags', why: '' }
}

const CURRENCIES = [
  { value: 'usd', label: 'USD — US dollar' },
  { value: 'gbp', label: 'GBP — pound sterling' },
  { value: 'eur', label: 'EUR — euro' },
  { value: 'aud', label: 'AUD — Australian dollar' },
  { value: 'cad', label: 'CAD — Canadian dollar' },
  { value: 'inr', label: 'INR — Indian rupee' },
  { value: 'lkr', label: 'LKR — Sri Lankan rupee' }
]

/** Every described key has a group; the two tables are kept in step by this. */
export function describedKeys(): string[] {
  return [...Object.keys(PLATFORM), ...Object.keys(BROWSER)].filter(
    (key) => groupOf('platform', key) !== null || groupOf('browser', key) !== null
  )
}

export function PlatformSetting({
  settingKey,
  value
}: {
  settingKey: string
  value: unknown
}): React.JSX.Element {
  const described = PLATFORM[settingKey]
  if (!described) return <RawSetting settingKey={settingKey} target="platform" value={value} />

  const asText = typeof value === 'string' ? value : ''
  const asNumber = typeof value === 'number' ? value : 0

  switch (settingKey) {
    case 'stripe_mode':
      return (
        <ChoiceSetting
          settingKey={settingKey}
          target="platform"
          label={described.label}
          why={described.why}
          value={asText === '' ? 'test' : asText}
          options={[
            { value: 'test', label: 'Test — no real money' },
            { value: 'live', label: 'Live — real charges' }
          ]}
          after={(chosen) =>
            chosen === 'live' ? (
              <>
                the portal will say <strong>live</strong>
              </>
            ) : (
              'the portal will say test'
            )
          }
        />
      )

    case 'currency': {
      const known = CURRENCIES.some((entry) => entry.value === asText)
      return (
        <ChoiceSetting
          settingKey={settingKey}
          target="platform"
          label={described.label}
          why={described.why}
          value={known ? asText : 'usd'}
          options={
            known || asText === ''
              ? CURRENCIES
              : [...CURRENCIES, { value: asText, label: `${asText.toUpperCase()} — as stored` }]
          }
        />
      )
    }

    case 'min_lead_time_hours':
      return (
        <NumberSetting
          settingKey={settingKey}
          target="platform"
          label={described.label}
          why={described.why}
          value={asNumber === 0 ? 12 : asNumber}
          unit="hours"
          step="1"
          min="0"
          after={(typed) =>
            typed < 12 ? (
              <span style={{ color: 'var(--warn)' }}>
                under 12 hours — many readers will miss the start
              </span>
            ) : (
              <>
                about <strong>{Math.round(typed / 6)}</strong> collection rounds of warning
              </>
            )
          }
        />
      )

    case 'support_email':
      return (
        <TextSetting
          settingKey={settingKey}
          target="platform"
          label={described.label}
          why={described.why}
          type="email"
          value={asText}
          placeholder="hello@yourdomain.com"
        />
      )

    default:
      return (
        <TextSetting
          settingKey={settingKey}
          target="platform"
          label={described.label}
          why={described.why}
          value={asText}
          placeholder="pk_test_… or pk_live_…"
        />
      )
  }
}

export function BrowserSetting({
  settingKey,
  value
}: {
  settingKey: string
  value: unknown
}): React.JSX.Element {
  const described = BROWSER[settingKey]
  if (!described) return <RawSetting settingKey={settingKey} target="browser" value={value} />

  switch (settingKey) {
    case 'show_advertise_cta':
      return (
        <BooleanSetting
          settingKey={settingKey}
          target="browser"
          label={described.label}
          why={described.why}
          value={value === true}
          on="Shown"
          off="Hidden"
        />
      )
    case 'notice':
      return <NoticeSetting value={asNotice(value)} />
    default:
      return <FlagsSetting value={asFlags(value)} />
  }
}

/**
 * The stored shapes, defensively.
 *
 * These rows have been hand-edited as JSON for as long as they have existed,
 * so either can hold anything — including a string where an object belongs. A
 * page that throws on a malformed row is a page that cannot be used to *fix*
 * the row, which is the only reason anybody would open it.
 */
function asNotice(value: unknown): { message?: string; level?: string; url?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  return {
    message: typeof record.message === 'string' ? record.message : '',
    level: typeof record.level === 'string' ? record.level : 'info',
    url: typeof record.url === 'string' ? record.url : ''
  }
}

function asFlags(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const flags: Record<string, boolean> = {}
  for (const [name, on] of Object.entries(value as Record<string, unknown>)) {
    flags[name] = on === true
  }
  return flags
}
