import { redirect } from 'next/navigation'
import { Group } from '@/components/Field'
import {
  BooleanSetting,
  FlagsSetting,
  NoticeSetting,
  RawSetting
} from '@/components/SettingField'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

/**
 * Remote configuration every copy of the browser reads.
 *
 * Each row here changes something in front of users, so the screen is built
 * around what it does rather than around how it is stored: a switch for the
 * advertise entry point, three fields for the notice, one switch per rollout
 * flag. The table is still `jsonb` and the values still travel as JSON — the
 * difference is that a control cannot produce the wrong shape, and `"level":
 * "warning"` (a plausible guess where the browser wants `warn`) is no longer
 * something an operator can type into a notice that then silently never
 * appears.
 */
export default async function BrowserConfigPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const { data } = await supabaseService().from('browser_settings').select('key, value').order('key')
  const rows = data ?? []
  const find = (key: string): unknown => rows.find((row) => row.key === key)?.value

  const described = ['show_advertise_cta', 'notice', 'feature_flags']
  const others = rows.filter((row) => !described.includes(row.key))

  const notice = asNotice(find('notice'))
  const flags = asFlags(find('feature_flags'))

  return (
    <main>
      <h1>Browser</h1>
      <p className="lede">
        Configuration every copy of Slash reads. Changes reach browsers on their next check — within
        a few minutes, not instantly.
      </p>

      <div className="card" style={{ borderColor: 'var(--warn)', marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>This table is public</h3>
        <p className="note">
          Browsers read it without signing in, because requiring a key would mean every installation
          carried one — and a per-installation key is an identifier. Anything saved here is readable
          by anyone who looks, so put nothing in it that is not already public.
        </p>
      </div>

      <Group title="Start page">
        <BooleanSetting
          settingKey="show_advertise_cta"
          target="browser"
          label="Offer &ldquo;Advertise on Slash&rdquo;"
          value={find('show_advertise_cta') === true}
          on="Shown"
          off="Hidden"
          why="Whether the start page offers the entry point to the advertising portal. Off removes the link; it does not stop campaigns running."
        />
        <NoticeSetting value={notice} />
      </Group>

      <Group title="Rollout">
        <FlagsSetting value={flags} />
      </Group>

      {others.length > 0 && (
        <Group title="Not described yet">
          {others.map((row) => (
            <RawSetting key={row.key} settingKey={row.key} target="browser" value={row.value} />
          ))}
        </Group>
      )}
    </main>
  )
}

/**
 * The stored shape, defensively.
 *
 * This row has been hand-edited as JSON for as long as it has existed, so it
 * can hold anything — including a string where an object belongs. A page that
 * throws on a malformed row is a page that cannot be used to *fix* the row.
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
