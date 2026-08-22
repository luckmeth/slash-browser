import { redirect } from 'next/navigation'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'
import { SettingRow } from '@/components/SettingRow'

export const dynamic = 'force-dynamic'

const HINTS: Record<string, string> = {
  show_advertise_cta:
    'true or false. Whether the browser start page offers the "advertise here" entry point.',
  notice:
    'A message shown on the start page. Set message to "" to clear it. level is "info", "warn" or "urgent"; url is optional and must be https.',
  feature_flags:
    'An object of flag names to true/false. The browser treats a flag it does not recognise, or one that is missing, as off — so removing a flag here turns it off rather than breaking anything.'
}

export default async function BrowserConfigPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const { data } = await supabaseService().from('browser_settings').select('key, value').order('key')

  return (
    <main>
      <h1>Browser config</h1>
      <p className="lede">
        Remote configuration every copy of Slash reads. Changes reach browsers on their next check —
        not instantly.
      </p>

      <div className="card" style={{ borderColor: 'var(--warn)' }}>
        <h3 style={{ marginTop: 0 }}>This table is public</h3>
        <p className="note">
          Browsers read it without signing in, because requiring a key would mean every installation
          carried one — and a per-installation key is an identifier. So anything saved here is
          readable by anyone who looks. Put nothing in it that is not already public.
        </p>
      </div>

      <div className="stack" style={{ marginTop: 16 }}>
        {(data ?? []).map((row) => (
          <SettingRow
            key={row.key}
            settingKey={row.key}
            value={row.value}
            hint={HINTS[row.key] ?? ''}
            target="browser"
          />
        ))}
      </div>
    </main>
  )
}
