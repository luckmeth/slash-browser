'use client'

import { useActionState, useState } from 'react'
import { setSuspended, type CollectorResult } from '@/app/collectors/actions'

/**
 * Suspending somebody, behind one deliberate extra click.
 *
 * It stops an account earning without telling them why, which is the correct
 * behaviour for an anti-abuse control and a terrible thing to do by accident
 * from a mis-click on a list. The confirmation is not a dialog — it is the
 * button changing into a question, which cannot be dismissed by pressing
 * Enter on the wrong window.
 */
export function SuspendButton({
  id,
  suspended
}: {
  id: string
  suspended: boolean
}): React.JSX.Element {
  const [state, action, working] = useActionState<CollectorResult, FormData>(
    setSuspended,
    undefined
  )
  const [asking, setAsking] = useState(false)

  // Lifting a suspension needs no confirmation: it is the recoverable
  // direction, and making somebody confirm before *un*-punishing an account is
  // friction pointing the wrong way.
  if (suspended) {
    return (
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="suspended" value="false" />
        <button type="submit" className="secondary" disabled={working}>
          {working ? 'Lifting…' : 'Lift suspension'}
        </button>
        {state && 'ok' in state && <p className="ok">{state.ok}</p>}
        {state && 'error' in state && <p className="error">{state.error}</p>}
      </form>
    )
  }

  if (!asking) {
    return (
      <div>
        <button type="button" className="danger" onClick={() => setAsking(true)}>
          Suspend account
        </button>
        {state && 'ok' in state && <p className="ok">{state.ok}</p>}
      </div>
    )
  }

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="suspended" value="true" />
      <p className="note" style={{ marginBottom: 8 }}>
        They will earn nothing from now on and will not be told. Their history is kept.
      </p>
      <div className="row">
        <button type="submit" className="danger" disabled={working}>
          {working ? 'Suspending…' : 'Yes, suspend'}
        </button>
        <button type="button" className="secondary" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
      {state && 'error' in state && <p className="error">{state.error}</p>}
    </form>
  )
}
