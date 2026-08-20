import { useEffect, useState } from 'react'
import type { VaultStatus } from '@shared/types/logins'
import { Icon } from '../../components/Icon'

/**
 * Saved sign-ins.
 *
 * The list shows sites and usernames. It never shows a password and cannot: no
 * IPC channel returns one, and `SavedLogin` has no field to carry one. Filling
 * happens in the main process, straight into the page through Chromium's input
 * pipeline, so a saved password is never handed to this document at all.
 *
 * There is deliberately no "reveal password" button. It would require exactly
 * the channel the design refuses to have, and its usual purpose — copying a
 * password out to use elsewhere — is better served by a real password manager.
 */
export function PasswordsSection(): React.JSX.Element {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [adding, setAdding] = useState(false)
  const [host, setHost] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.browser.invoke('vault:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }, [])

  if (!status) {
    return <p className="text-xs text-[var(--color-text-muted)]">Loading…</p>
  }

  // Said plainly rather than letting the user save into a void. The vault
  // refuses to store anything without an OS credential store, so the interface
  // must not offer a form that will always fail.
  if (!status.available) {
    return (
      <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        This system has no secure credential store available, so Slash will not save passwords.
        Keeping them in readable form beside your browsing history is not something it will do.
      </p>
    )
  }

  const submit = (): void => {
    void window.browser
      .invoke('vault:save', { host, username, password })
      .then((result) => {
        if (!result.ok) return
        setStatus(result.value.status)
        setError(result.value.error)
        if (result.value.error === null) {
          setHost('')
          setUsername('')
          setPassword('')
          setAdding(false)
        }
      })
  }

  return (
    <div>
      {status.logins.length === 0 ? (
        <p className="mb-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          Nothing saved yet. Add a sign-in here and Slash will offer to type it when you reach that
          site.
        </p>
      ) : (
        <ul className="mb-2 flex flex-col gap-1">
          {status.logins.map((login) => (
            <li
              key={login.id}
              className="group flex items-center gap-2 rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5"
            >
              <Icon name="lock" size={13} className="shrink-0 text-[var(--color-text-muted)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{login.host}</span>
                <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                  {login.username || 'no username'}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Remove the sign-in for ${login.host}`}
                onClick={() => {
                  void window.browser.invoke('vault:remove', { id: login.id }).then((result) => {
                    if (result.ok) setStatus(result.value)
                  })
                }}
                className="shrink-0 cursor-default rounded p-1 text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100 hover:bg-white/15 focus:opacity-100"
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="flex flex-col gap-1.5">
          <input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="example.com"
            aria-label="Site"
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Username or email"
            aria-label="Username"
            autoComplete="off"
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            aria-label="Password"
            autoComplete="new-password"
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          {error && <p className="text-[11px] text-[var(--color-danger)]">{error}</p>}
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={submit}
              className="cursor-default rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-black transition hover:brightness-110"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false)
                setError(null)
                setPassword('')
              }}
              className="cursor-default rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs transition hover:bg-white/10"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="cursor-default rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs transition hover:bg-white/10"
        >
          Add a sign-in
        </button>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Passwords are encrypted by Windows against your user account and are never shown again, not
        even here. Slash types a saved sign-in into the page as if you typed it; it does not read
        what you type into sign-in forms, so it cannot capture one automatically.
      </p>

      {status.logins.length > 0 && (
        <button
          type="button"
          onClick={() => {
            void window.browser.invoke('vault:clearAll', undefined).then((result) => {
              if (result.ok) setStatus(result.value)
            })
          }}
          className="mt-2 cursor-default text-[11px] text-[var(--color-danger)] transition hover:underline"
        >
          Delete all saved sign-ins
        </button>
      )}
    </div>
  )
}
