'use client'

import { useActionState } from 'react'
import { publishRelease, unpublishRelease, type ReleaseResult } from '@/app/releases/actions'

export function ReleaseForm(): React.JSX.Element {
  const [state, action, busy] = useActionState<ReleaseResult, FormData>(publishRelease, undefined)

  return (
    <form className="card stack" action={action}>
      <h3 style={{ marginTop: 0 }}>Publish a release</h3>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 140px' }}>
          <label htmlFor="version">Version</label>
          <input id="version" name="version" placeholder="0.2.0" required />
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <label htmlFor="channel">Channel</label>
          <select id="channel" name="channel" defaultValue="stable">
            <option value="stable">stable</option>
            <option value="beta">beta</option>
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="releaseUrl">Release page</label>
        <input id="releaseUrl" name="releaseUrl" placeholder="https://…/releases/v0.2.0" required />
        <p className="note">
          Where somebody goes to read about it and download it. Required — until the build is
          code-signed it cannot install itself, so this link <em>is</em> the update path.
        </p>
      </div>
      <div>
        <label htmlFor="notes">Notes (for your own records)</label>
        <textarea id="notes" name="notes" />
      </div>
      {state && 'error' in state && <p className="error">{state.error}</p>}
      {state && 'ok' in state && <p className="note" style={{ color: 'var(--good)' }}>{state.ok}</p>}
      <button type="submit" disabled={busy}>
        {busy ? 'Publishing…' : 'Publish'}
      </button>
    </form>
  )
}

export function PullButton({ id }: { id: string }): React.JSX.Element {
  const [state, action, busy] = useActionState<ReleaseResult, FormData>(unpublishRelease, undefined)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="danger" disabled={busy}>
        {busy ? 'Pulling…' : 'Pull'}
      </button>
      {state && 'error' in state && <div className="error">{state.error}</div>}
    </form>
  )
}
