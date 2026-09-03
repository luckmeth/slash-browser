import { redirect } from 'next/navigation'
import { Group } from '@/components/Field'
import {
  ChoiceSetting,
  NumberSetting,
  RawSetting,
  TextSetting
} from '@/components/SettingField'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

const CURRENCIES = [
  { value: 'usd', label: 'USD — US dollar' },
  { value: 'gbp', label: 'GBP — pound sterling' },
  { value: 'eur', label: 'EUR — euro' },
  { value: 'aud', label: 'AUD — Australian dollar' },
  { value: 'cad', label: 'CAD — Canadian dollar' },
  { value: 'inr', label: 'INR — Indian rupee' },
  { value: 'lkr', label: 'LKR — Sri Lankan rupee' }
]

/**
 * Operator configuration.
 *
 * The values here were edited as raw `jsonb` — `"test"` with the quotes
 * load-bearing, `12` without them — which asked somebody changing a support
 * email address to know how we store it. They are controls now; the value
 * still travels as JSON, produced by a control that cannot get the shape
 * wrong.
 *
 * What has not changed is which secrets are absent, and why. That card stays.
 */
export default async function SettingsPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const { data } = await supabaseService()
    .from('platform_settings')
    .select('key, value')
    .order('key')

  const rows = data ?? []
  const find = (key: string): unknown => rows.find((row) => row.key === key)?.value
  const text = (key: string): string => (typeof find(key) === 'string' ? (find(key) as string) : '')
  const num = (key: string, fallback: number): number =>
    typeof find(key) === 'number' ? (find(key) as number) : fallback

  const described = [
    'stripe_mode',
    'stripe_publishable_key',
    'currency',
    'support_email',
    'min_lead_time_hours'
  ]
  const others = rows.filter((row) => !described.includes(row.key))

  const currency = text('currency') === '' ? 'usd' : text('currency')
  const knownCurrency = CURRENCIES.some((entry) => entry.value === currency)

  return (
    <main>
      <h1>Settings</h1>
      <p className="lede">
        How payments are taken and how campaigns are scheduled. Slash Coin has its own screen, and
        anything the browser reads is under Browser.
      </p>

      <Group title="Payments">
        <ChoiceSetting
          settingKey="stripe_mode"
          target="platform"
          label="Stripe mode"
          value={text('stripe_mode') === '' ? 'test' : text('stripe_mode')}
          options={[
            { value: 'test', label: 'Test — no real money' },
            { value: 'live', label: 'Live — real charges' }
          ]}
          why="A label for your own benefit. What actually decides whether real money moves is which secret key is set in the host environment — this does not switch it."
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
        <TextSetting
          settingKey="stripe_publishable_key"
          target="platform"
          label="Stripe publishable key"
          value={text('stripe_publishable_key')}
          placeholder="pk_test_… or pk_live_…"
          why="Safe to be public: it identifies your Stripe account and authorises nothing. The secret key is deliberately not here — see below."
        />
        <ChoiceSetting
          settingKey="currency"
          target="platform"
          label="Currency"
          value={knownCurrency ? currency : 'usd'}
          options={
            knownCurrency
              ? CURRENCIES
              : [...CURRENCIES, { value: currency, label: `${currency.toUpperCase()} — as stored` }]
          }
          why="What prices are quoted and charged in. Changing it does not convert existing prices — it relabels them."
        />
      </Group>

      <Group title="Scheduling and contact">
        <NumberSetting
          settingKey="min_lead_time_hours"
          target="platform"
          label="Minimum lead time"
          value={num('min_lead_time_hours', 12)}
          unit="hours"
          step="1"
          min="0"
          why="How far ahead of now a campaign is allowed to start. Browsers collect adverts every six hours, so anything under about 12 will not reach most readers before it is already running."
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
        <TextSetting
          settingKey="support_email"
          target="platform"
          label="Support email"
          type="email"
          value={text('support_email')}
          placeholder="hello@yourdomain.com"
          why="Shown on the public site as a way to ask a question before signing up. Empty removes it from the page rather than showing an empty link."
        />
      </Group>

      {others.length > 0 && (
        <Group title="Not described yet">
          {others.map((row) => (
            <RawSetting key={row.key} settingKey={row.key} target="platform" value={row.value} />
          ))}
        </Group>
      )}

      <div className="card" style={{ borderColor: 'var(--warn)', marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>Where the secret keys live</h3>
        <p className="note">
          The Stripe <strong>secret key</strong> and <strong>webhook signing secret</strong> are not
          here, and should not be added. They are read from the host&rsquo;s encrypted environment
          (<code>STRIPE_SECRET_KEY</code>, <code>STRIPE_WEBHOOK_SECRET</code>). A secret stored in a
          database row is only as protected as the key encrypting it, and that key has to live in an
          environment variable anyway — so putting it here would give you two copies of the secret
          and no extra safety.
        </p>
        <p className="note">
          Email delivery is the same: in <strong>Slash Operations</strong> the Resend key is entered
          under <strong>Setup → Database key and email delivery</strong>, and on a web deployment it
          is <code>RESEND_API_KEY</code> in the host environment.
        </p>
        <p className="note">
          Going live is still configuration and not code: set the live key in your host&rsquo;s
          dashboard and change <strong>Stripe mode</strong> above.
        </p>
      </div>
    </main>
  )
}
