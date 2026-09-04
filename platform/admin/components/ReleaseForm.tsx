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
        <label htmlFor="fileUrl">Installer address (optional)</label>
        <input id="fileUrl" name="fileUrl" placeholder="https://…/Slash-Setup-0.2.0.exe" />
        <p className="note">
          Give this and browsers fetch the installer themselves, check it against a checksum, and
          offer to install it. Leave it empty and they only learn a version exists and point people
          at the release page. It must be <code>https</code>, and on Slash&rsquo;s own Supabase host
          or a GitHub release asset — the browser refuses to fetch an executable from anywhere else.
        </p>
        <p className="note">
          <strong>Publishing will download it once</strong> to measure the checksum, so expect this
          to take a minute on a large installer.
        </p>
      </div>
      <details className="advanced">
        <summary>Checksum — computed for you unless you paste one</summary>
        <div style={{ padding: '14px 18px' }}>
          <label htmlFor="sha512">SHA-512</label>
          <input id="sha512" name="sha512" placeholder="left empty: measured from the file" spellCheck={false} />
          <p className="note">
            Publishing fetches the installer and hashes it, so this is normally left empty —
            transcribing 128 characters is the one mistake that makes every update fail
            verification, and the failure looks like a broken updater rather than a typo. Paste one
            only to pin a value you have already verified elsewhere.
          </p>
          <label htmlFor="sizeBytes" style={{ marginTop: 12 }}>
            Size in bytes
          </label>
          <input id="sizeBytes" name="sizeBytes" type="number" min="0" placeholder="measured too" />
        </div>
      </details>
      <div>
        <label htmlFor="notes">Notes</label>
        <textarea id="notes" name="notes" placeholder="Shown in the browser beside the update." />
      </div>
      {state && 'error' in state && <p className="error">{state.error}</p>}
      {state && 'ok' in state && <p className="note" style={{ color: 'var(--good)' }}>{state.ok}</p>}
      <button type="submit" disabled={busy}>
        {busy ? 'Publishing — fetching and hashing the installer…' : 'Publish'}
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
