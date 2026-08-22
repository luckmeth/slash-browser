import { useEffect, useState } from 'react'
import type { SyncStatus } from '@shared/types/sync'
import { useBrowserStore } from '../../stores/browserStore'

/**
 * Sync, written to be read before it is switched on.
 *
 * The passphrase is the whole of the security and the whole of the risk, so both
 * halves are stated here rather than discovered: the server never sees anything
 * readable, and nobody — including us — can recover the data if the passphrase
 * is forgotten. A settings screen that mentions only the first half is selling
 * something.
 */
export function SyncSection(): React.JSX.Element {
  const settings = useBrowserStore((s) => s.settings)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)

  const enabled = settings?.syncEnabled ?? false
  const endpoint = settings?.syncEndpoint ?? ''
  const token = settings?.syncToken ?? ''

  const load = (): void => {
    void window.browser.invoke('sync:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  useEffect(load, [enabled, endpoint])
  useEffect(() => window.browser.on('sync:changed', setStatus), [])

  const update = (patch: Record<string, unknown>): void => {
    void window.browser.invoke('settings:update', patch)
  }

  return (
    <div>
      <label className="flex cursor-default items-start justify-between gap-2 rounded-lg border border-[var(--glass-edge)] px-2.5 py-2">
        <span className="min-w-0">
          <span className="block text-xs">Sync bookmarks and reading list</span>
          <span className="mt-0.5 block text-[10px] leading-snug text-[var(--color-text-muted)]">
            Between your own machines, encrypted so the server cannot read any of it.
          </span>
        </span>
        <input
          type="checkbox"
          className="mt-0.5 shrink-0"
          checked={enabled}
          onChange={(event) => update({ syncEnabled: event.target.checked })}
        />
      </label>

      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Your bookmarks and reading list are encrypted <strong>on this machine</strong> with a key
        derived from a passphrase you choose. The server stores the result and a timestamp — it
        never sees a page address, a title, or anything else about what you saved.
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-warn)]">
        The passphrase is never sent anywhere and is not stored. If you forget it, the synced data
        cannot be recovered — not by us, not by anyone. There is deliberately no spare key.
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        History is not synced. It is the largest and most revealing thing this browser holds, and
        sending it anywhere is a different promise from the one Slash makes.
      </p>

      {status && (
        <div className="mt-2.5 flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
          {!status.configured && <span>No sync server is set up, so nothing is ever contacted.</span>}
          {status.configured && !status.unlocked && (
            <span>Locked. Enter your passphrase to sync on this machine.</span>
          )}
          {status.unlocked && (
            <>
              <span>{status.itemCount} item(s) on this machine.</span>
              <span>
                {status.lastSyncAt
                  ? `Last synced ${new Date(status.lastSyncAt).toLocaleString()}.`
                  : 'Not synced yet.'}
              </span>
            </>
          )}
          {status.lastError && (
            <span role="status" aria-live="polite" className="text-[var(--color-warn)]">
              {status.lastError}
            </span>
          )}
        </div>
      )}

      {enabled && endpoint !== '' && (
        <div className="mt-2.5">
          {status?.unlocked ? (
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void window.browser.invoke('sync:now', undefined).then(() => setBusy(false))
                }}
                className="cursor-default rounded-md border border-[var(--glass-edge)] px-2.5 py-1 text-xs transition hover:border-[var(--color-accent)] disabled:opacity-50"
              >
                {busy ? 'Syncing…' : 'Sync now'}
              </button>
              <button
                type="button"
                onClick={() => void window.browser.invoke('sync:lock', undefined)}
                className="cursor-default rounded-md border border-[var(--glass-edge)] px-2.5 py-1 text-xs transition hover:border-[var(--color-accent)]"
              >
                Lock
              </button>
            </div>
          ) : (
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                setBusy(true)
                setProblem('')
                void window.browser
                  .invoke('sync:unlock', { passphrase })
                  .then((result) => {
                    setBusy(false)
                    if (result.ok && !result.value.ok) setProblem(result.value.problem)
                    // Cleared either way: there is no reason for it to sit in a
                    // React state tree once it has been used.
                    if (result.ok && result.value.ok) setPassphrase('')
                  })
              }}
            >
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder="Sync passphrase"
                autoComplete="off"
                aria-label="Sync passphrase"
                className="min-w-0 flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <button
                type="submit"
                disabled={busy || passphrase.length < 8}
                className="shrink-0 cursor-default rounded-md border border-[var(--glass-edge)] px-2.5 py-1 text-xs transition hover:border-[var(--color-accent)] disabled:opacity-50"
              >
                Unlock
              </button>
            </form>
          )}
          {problem !== '' && (
            <p role="status" aria-live="polite" className="mt-1.5 text-[11px] text-[var(--color-warn)]">
              {problem}
            </p>
          )}
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-default text-[11px] text-[var(--color-text-muted)]">
          Sync server
        </summary>
        <input
          value={endpoint}
          onChange={(event) => update({ syncEndpoint: event.target.value })}
          placeholder="https://example.com/api/sync"
          aria-label="Sync endpoint"
          className="mt-1.5 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <input
          value={token}
          onChange={(event) => update({ syncToken: event.target.value })}
          placeholder="Access token (if your server needs one)"
          aria-label="Sync access token"
          className="mt-1.5 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          Any server implementing the protocol in <code>docs/sync.md</code>. It only ever receives
          encrypted blobs, so it does not have to be one you trust with your browsing — only one you
          trust to keep the bytes.
        </p>
        <button
          type="button"
          onClick={() => void window.browser.invoke('sync:reset', undefined)}
          className="mt-1.5 cursor-default rounded-md border border-[var(--glass-edge)] px-2.5 py-1 text-xs transition hover:border-[var(--color-warn)]"
        >
          Forget this device&rsquo;s sync setup
        </button>
      </details>
    </div>
  )
}
