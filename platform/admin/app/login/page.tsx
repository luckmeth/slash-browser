import { redirect } from 'next/navigation'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'
import { AdminLoginForm } from '@/components/AdminLoginForm'
import { FirstOperatorForm } from '@/components/FirstOperatorForm'

export const dynamic = 'force-dynamic'

export default async function LoginPage(): Promise<React.JSX.Element> {
  if (await currentAdmin()) redirect('/')

  // Whether anybody can sign in at all. With no operator, a login form is a
  // dead end — and the only ways out used to be running the public advertiser
  // site in a terminal to reach its signup form, then a third tool to grant the
  // row. Three applications for one account is not a setup process.
  let operatorCount = 0
  let reachable = true
  try {
    const { count, error } = await supabaseService()
      .from('admin_users')
      .select('id', { count: 'exact', head: true })
    if (error) throw error
    operatorCount = count ?? 0
  } catch {
    // Cannot tell. The login form is the safe thing to show: it fails with a
    // message, whereas offering to create an operator against a database we
    // cannot read would fail confusingly.
    reachable = false
  }

  return (
    <main className="narrow">
      <h1>Operations</h1>
      <p className="lede">
        The advert review queue, pricing, releases and browser configuration.
      </p>

      {!reachable && (
        <p className="banner">
          The database could not be reached. Check the service-role key this app was given.
        </p>
      )}

      {reachable && operatorCount === 0 ? (
        <FirstOperatorForm />
      ) : (
        <AdminLoginForm />
      )}
    </main>
  )
}
