import { redirect } from 'next/navigation'
import { AuthForm } from '@/components/AuthForm'
import { currentAdvertiser } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function SignupPage(): Promise<React.JSX.Element> {
  if (await currentAdvertiser()) redirect('/dashboard')

  return (
    <main className="narrow">
      <h1>Create an account</h1>
      <p className="lede">
        Free to open. You are charged only when you book a campaign, and only for the hours you
        choose.
      </p>
      <AuthForm mode="signup" />
    </main>
  )
}
