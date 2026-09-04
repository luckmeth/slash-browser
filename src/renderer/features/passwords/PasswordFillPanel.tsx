import { useCallback, useEffect, useState } from 'react'
import type { SavedLogin } from '@shared/types/logins'
import { CHROME_HEIGHT } from '@shared/constants'
import { Icon } from '../../components/Icon'

/**
 * The accounts Slash can type into the page in front of you.
 *
 * Renders in the overlay because it must draw over page content — a toolbar
 * dropdown in the chrome document is composited *underneath* the native page
 * view, which is the bug the shield panel shipped with.
 *
 * No password is ever sent to this document. Choosing an account sends an id;
 * the main process decrypts, and the value goes into the page through
 * Chromium's input pipeline without passing through any renderer.
 */
export function PasswordFillPanel(): React.JSX.Element {
  const [matches, setMatches] = useState<SavedLogin[] | null>(null)
  const [host, setHost] = useState('')
  const [tabId, setTabId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const close = useCallback((): void => {
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }, [])

  useEffect(() => {
    void window.browser.invoke('tabs:list', undefined).then((tabs) => {
      if (!tabs.ok || !tabs.value.activeTabId) {
        close()
        return
      }
      const id = tabs.value.activeTabId
      setTabId(id)
      void window.browser.invoke('vault:formForTab', { tabId: id }).then((result) => {
        if (!result.ok) {
          close()
          return
        }
        setHost(result.value.host)
        setMatches(result.value.matches)
      })
    })
  }, [close])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const fill = (login: SavedLogin): void => {
    if (!tabId) return
    void window.browser.invoke('vault:fill', { tabId, loginId: login.id }).then((result) => {
      if (!result.ok) return
      if (result.value.error) setError(result.value.error)
      else close()
    })
  }

  return (
    <div className="fixed inset-0" onClick={close}>
      {matches !== null && (
        <div
          className="glass-float animate-rise absolute right-3 w-72 rounded-xl p-3"
          style={{ top: CHROME_HEIGHT + 6 }}
          onClick={(event) => event.stopPropagation()}
        >
          <p className="text-sm font-medium">Sign in to {host || 'this site'}</p>

          {matches.length === 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
              Nothing saved for this site yet. You can add one in Settings, under Saved sign-ins.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1">
              {matches.map((login) => (
                <li key={login.id}>
                  <button
                    type="button"
                    onClick={() => fill(login)}
                    className="flex w-full cursor-default items-center gap-2 rounded-lg border border-[var(--glass-edge)] px-2.5 py-2 text-left transition hover:bg-[var(--glass-high)]"
                  >
                    <Icon name="lock" size={13} className="shrink-0 text-[var(--color-accent)]" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {login.username || 'Saved sign-in'}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
                      Fill
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && <p className="mt-2 text-[11px] text-[var(--color-danger)]">{error}</p>}

          <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            Slash types this into the page as if you typed it. Check the address bar first — a
            saved sign-in is only ever offered for the site it was saved on.
          </p>
        </div>
      )}
    </div>
  )
}
