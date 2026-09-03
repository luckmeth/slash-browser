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
          With this and a checksum, browsers fetch the installer themselves and verify it before
          running it. Without them they only learn that a version exists and send people to the
          release page. It must be <code>https</code>, and on the same host as this feed or a GitHub
          release asset — the browser refuses to fetch an executable from anywhere else.
        </p>
      </div>
      <div>
        <label htmlFor="sha512">SHA-512 of that file (optional)</label>
        <input id="sha512" name="sha512" placeholder="hex or base64" spellCheck={false} />
        <p className="note">
          <code>certutil -hashfile &quot;Slash Setup 0.2.0.exe&quot; SHA512</code> on Windows, or{' '}
          <code>shasum -a 512</code> elsewhere. A download that does not match is deleted by the
          browser and nothing is installed. This is integrity, not a signature: anybody who can edit
          this row can change the file and this value together.
        </p>
      </div>
      <div>
        <label htmlFor="sizeBytes">Size in bytes (optional)</label>
        <input id="sizeBytes" name="sizeBytes" type="number" min="0" placeholder="188000000" />
        <p className="note">Checked after the download, and used to show a progress bar.</p>
      </div>
      <div>
        <label htmlFor="notes">Notes</label>
        <textarea id="notes" name="notes" placeholder="Shown in the browser beside the update." />
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
