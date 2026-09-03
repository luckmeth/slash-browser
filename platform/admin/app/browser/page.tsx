import { redirect } from 'next/navigation'
import { Group } from '@/components/Field'
import { BrowserSetting, BROWSER_GROUPS, groupOf } from '@/components/settingsCatalogue'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

/**
 * Remote configuration every copy of the browser reads.
 *
 * Built around what each row does rather than how it is stored: a switch for
 * the advertise entry point, three fields for the notice, one switch per
 * rollout flag. The table is still `jsonb` and the values still travel as
 * JSON — the difference is that a control cannot produce the wrong shape, and
 * `"level": "warning"` (a plausible guess where the browser wants `warn`) is
 * no longer something an operator can type into a notice that then silently
 * never appears.
 *
 * Like the settings page, this passes a key and a value: everything else lives
 * in the client-side catalogue. See the comment there for why that matters.
 */
export default async function BrowserConfigPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const { data, error } = await supabaseService()
    .from('browser_settings')
    .select('key, value')
    .order('key')

  const rows = data ?? []
  const undescribed = rows.filter((row) => groupOf('browser', row.key) === null)

  return (
    <main>
      <h1>Browser</h1>
      <p className="lede">
        Configuration every copy of Slash reads. Changes reach browsers on their next check — within
        a few minutes, not instantly.
      </p>

      {error && <p className="banner">Could not read the browser config ({error.message}).</p>}

      <div className="card" style={{ borderColor: 'var(--warn)', marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>This table is public</h3>
        <p className="note">
          Browsers read it without signing in, because requiring a key would mean every installation
          carried one — and a per-installation key is an identifier. Anything saved here is readable
          by anyone who looks, so put nothing in it that is not already public.
        </p>
      </div>

      {BROWSER_GROUPS.map((group) => {
        const inGroup = rows.filter((row) => groupOf('browser', row.key) === group)
        if (inGroup.length === 0) return null
        return (
          <Group key={group} title={group}>
            {inGroup.map((row) => (
              <BrowserSetting key={row.key} settingKey={row.key} value={row.value} />
            ))}
          </Group>
        )
      })}

      {undescribed.length > 0 && (
        <Group title="Not described yet">
          {undescribed.map((row) => (
            <BrowserSetting key={row.key} settingKey={row.key} value={row.value} />
          ))}
        </Group>
      )}
    </main>
  )
}
