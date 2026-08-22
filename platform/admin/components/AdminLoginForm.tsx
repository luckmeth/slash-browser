'use client'

import { useActionState } from 'react'
import { signIn, type LoginResult } from '@/app/login/actions'

export function AdminLoginForm(): React.JSX.Element {
  const [state, action, pending] = useActionState<LoginResult, FormData>(signIn, undefined)

  return (
    <form className="stack" action={action}>
      <div>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="email" />
      </div>
      <div>
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required autoComplete="current-password" />
      </div>
      {state?.error && <p className="error">{state.error}</p>}
      <div>
        <button type="submit" disabled={pending}>
          {pending ? 'One moment…' : 'Sign in'}
        </button>
      </div>
    </form>
  )
}
