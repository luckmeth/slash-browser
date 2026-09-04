import { redirect } from 'next/navigation'
import { Group } from '@/components/Field'
import { PlatformSetting } from '@/components/settingsCatalogue'
import { PLATFORM_GROUPS, groupOf } from '@/components/settingsGroups'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

/**
 * Operator configuration.
 *
 * The page passes a key and a value and nothing else. Everything about how a
 * setting is presented — its label, its explanation, and any hint computed
 * from what has just been typed — lives in `settingsCatalogue.tsx`, on the
 * client side of the boundary.
 *
 * That is not tidiness. This page previously passed a *function* to a client
 * component to render those hints, which React refuses: every request threw
 * before rendering anything, `next build` could not see it because the page is
 * dynamic, and the only trace was a line in the server log. The structure
 * above is the fix — there is no longer anywhere to put a function.
 */
export default async function SettingsPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const { data, error } = await supabaseService()
    .from('platform_settings')
    .select('key, value')
    .order('key')

  const rows = data ?? []
  const undescribed = rows.filter((row) => groupOf('platform', row.key) === null)

  return (
    <main>
      <h1>Settings</h1>
      <p className="lede">
        How payments are taken and how campaigns are scheduled. Slash Coin has its own screen, and
        anything the browser reads is under Browser.
      </p>

      {error && <p className="banner">Could not read the settings ({error.message}).</p>}

      {PLATFORM_GROUPS.map((group) => {
        const inGroup = rows.filter((row) => groupOf('platform', row.key) === group)
        if (inGroup.length === 0) return null
        return (
          <Group key={group} title={group}>
            {inGroup.map((row) => (
              <PlatformSetting key={row.key} settingKey={row.key} value={row.value} />
            ))}
          </Group>
        )
      })}

      {undescribed.length > 0 && (
        <Group title="Not described yet">
          {undescribed.map((row) => (
            <PlatformSetting key={row.key} settingKey={row.key} value={row.value} />
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
      </div>
    </main>
  )
}
