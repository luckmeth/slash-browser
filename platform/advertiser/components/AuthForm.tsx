'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { signIn, signInWithGoogle, signUp, type AuthResult } from '@/app/auth/actions'

/**
 * Sign in and sign up, which differ by one field and the verb.
 *
 * One component rather than two because a divergence between them is a
 * divergence in how accounts are created versus resumed — the sort of thing
 * that gets noticed only when somebody cannot get in.
 */
export function AuthForm({ mode }: { mode: 'signup' | 'login' }): React.JSX.Element {
  const isSignup = mode === 'signup'
  const [state, action, pending] = useActionState<AuthResult, FormData>(
    isSignup ? signUp : signIn,
    undefined
  )

  return (
    <>
      <form className="stack" action={action}>
        {isSignup && (
          <div>
            <label htmlFor="company">Company name</label>
            <input id="company" name="company" required maxLength={120} autoComplete="organization" />
          </div>
        )}
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required autoComplete="email" />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={isSignup ? 'new-password' : 'current-password'}
          />
          {isSignup && <p className="note">At least 8 characters.</p>}
        </div>

        {state?.error && <p className="error">{state.error}</p>}

        <div>
          <button type="submit" disabled={pending}>
            {pending ? 'One moment…' : isSignup ? 'Create account' : 'Sign in'}
          </button>
        </div>
      </form>

      <form action={signInWithGoogle} style={{ marginTop: 16 }}>
        <button type="submit" className="secondary">
          Continue with Google
        </button>
      </form>

      <p className="note" style={{ marginTop: 20 }}>
        {isSignup ? (
          <>
            Already registered? <Link href="/login">Sign in</Link>.
          </>
        ) : (
          <>
            No account yet? <Link href="/signup">Create one</Link>.
          </>
        )}
      </p>
    </>
  )
}
