import { redirect } from 'next/navigation'
import { currentAdmin } from '@/lib/supabase/server'
import { AdminLoginForm } from '@/components/AdminLoginForm'

export const dynamic = 'force-dynamic'

export default async function LoginPage(): Promise<React.JSX.Element> {
  if (await currentAdmin()) redirect('/')

  return (
    <main className="narrow">
      <h1>Operations</h1>
      <p className="lede">Internal tool. Sign in with an account listed in admin_users.</p>
      <AdminLoginForm />
    </main>
  )
}
