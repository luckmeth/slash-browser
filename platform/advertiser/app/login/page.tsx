import { redirect } from 'next/navigation'
import { AuthForm } from '@/components/AuthForm'
import { currentAdvertiser } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const NOTICES: Record<string, string> = {
  'check-email': 'Account created. Check your email for a confirmation link, then sign in.',
  'link-expired': 'That link has expired or was already used. Sign in, or request a new one.',
  'no-code': 'That sign-in link was incomplete. Try again.',
  unavailable: 'Google sign-in is not configured on this deployment yet.'
}

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<React.JSX.Element> {
  if (await currentAdvertiser()) redirect('/dashboard')

  const params = await searchParams
  const key =
    params['check-email'] !== undefined
      ? 'check-email'
      : typeof params.error === 'string'
        ? params.error
        : params.oauth === 'unavailable'
          ? 'unavailable'
          : ''
  const notice = NOTICES[key]

  return (
    <main className="narrow">
      <h1>Sign in</h1>
      {notice && <p className="banner">{notice}</p>}
      <AuthForm mode="login" />
    </main>
  )
}
