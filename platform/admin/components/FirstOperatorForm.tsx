'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useActionState } from 'react'
import { createFirstOperator, type BootstrapResult } from '@/app/login/bootstrap'
import { AdminLoginForm } from './AdminLoginForm'

/**
 * Shown only when `admin_users` is empty.
 *
 * On success it renders the sign-in form **itself**, rather than telling the
 * reader to look below for one that is not there. Which form this page shows is
 * decided on the server, before submitting; the account existing does not, on
 * its own, cause that decision to be made again. `router.refresh()` asks for
 * that re-render, but the form is rendered here regardless — a message that
 * points at something is worse than useless if the something takes a round trip
 * to arrive.
 */
export function FirstOperatorForm(): React.JSX.Element {
  const router = useRouter()
  const [state, action, busy] = useActionState<BootstrapResult, FormData>(
    createFirstOperator,
    undefined
  )
  const created = state !== undefined && 'ok' in state

  useEffect(() => {
    // So a reload, or anything else that re-reads this page, sees an operator
    // now exists and stops offering to create one.
    if (created) router.refresh()
  }, [created, router])

  if (created) {
    return (
      <>
        <p className="banner" style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>
          Operator created. Sign in with the email and password you just chose.
        </p>
        <AdminLoginForm />
      </>
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
