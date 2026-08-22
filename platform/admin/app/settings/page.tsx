import { redirect } from 'next/navigation'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'
import { SettingRow } from '@/components/SettingRow'

export const dynamic = 'force-dynamic'

const HINTS: Record<string, string> = {
  stripe_mode:
    '"test" or "live". This is a label for your own benefit — what actually decides whether real money moves is which secret key is set in the host environment.',
  stripe_publishable_key:
    'Safe to be public; it identifies your Stripe account and authorises nothing. The secret key is deliberately not here — see below.',
  currency: 'Three-letter code, lowercase, in quotes. Changing it does not convert existing prices.',
  support_email: 'Shown on the public site as a way to ask a question before signing up.',
  min_lead_time_hours:
    'How far ahead a campaign must start. Browsers collect adverts every six hours, so anything under about 12 will not reach most readers.'
}

export default async function SettingsPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const { data } = await supabaseService()
    .from('platform_settings')
    .select('key, value')
    .order('key')

  return (
    <main>
      <h1>Settings</h1>
      <p className="lede">
        Operator configuration. Values are JSON — text needs quotes, numbers and true/false do not.
      </p>

      <div className="card" style={{ borderColor: 'var(--warn)' }}>
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
          Going live is still configuration and not code: set the live key in your host&rsquo;s
          dashboard and change <code>stripe_mode</code> above.
        </p>
      </div>

      <div className="stack" style={{ marginTop: 16 }}>
        {(data ?? []).map((row) => (
          <SettingRow
            key={row.key}
            settingKey={row.key}
            value={row.value}
            hint={HINTS[row.key] ?? ''}
            target="platform"
          />
        ))}
      </div>
    </main>
  )
}
