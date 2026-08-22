'use client'

import { useActionState } from 'react'
import { createFirstOperator, type BootstrapResult } from '@/app/login/bootstrap'

/**
 * Shown only when `admin_users` is empty.
 *
 * Disappears the moment an operator exists, and the action behind it refuses
 * regardless of what this component decides to render.
 */
export function FirstOperatorForm(): React.JSX.Element {
  const [state, action, busy] = useActionState<BootstrapResult, FormData>(
    createFirstOperator,
    undefined
  )

  if (state && 'ok' in state) {
    return (
      <div className="card">
        <p style={{ margin: 0, color: 'var(--good)' }}>{state.ok}</p>
      </div>
    )
  }

  return (
    <form className="card stack" action={action}>
      <h3 style={{ marginTop: 0 }}>No operator exists yet</h3>
      <p className="note" style={{ marginTop: 0 }}>
        Create the first one. This account can approve what appears on the start page of every copy
        of Slash, so it is worth a password you do not use anywhere else.
      </p>
      <div>
        <label htmlFor="bootstrap-email">Email</label>
        <input id="bootstrap-email" name="email" type="email" required autoComplete="email" />
      </div>
      <div>
        <label htmlFor="bootstrap-password">Password</label>
        <input
          id="bootstrap-password"
          name="password"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
        />
        <p className="note">At least 10 characters.</p>
      </div>
      {state && 'error' in state && <p className="error">{state.error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create operator'}
      </button>
    </form>
  )
}
