import { useCallback, useEffect, useState } from 'react'

interface Profile {
  id: string
  name: string
  createdAt: number
}

/**
 * Separate people on one machine.
 *
 * A profile is not a workspace, and the copy here says so: a workspace keeps
 * tabs apart inside one person's browser, sharing their history, bookmarks,
 * passwords and settings. A profile shares none of those. Confusing the two is
 * how somebody creates a profile expecting a tab group and finds an empty
 * browser.
 */
export function ProfileSection(): React.JSX.Element {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [activeId, setActiveId] = useState('default')
  const [newName, setNewName] = useState('')
  const [problem, setProblem] = useState('')

  const load = useCallback((): void => {
    void window.browser.invoke('profiles:list', undefined).then((result) => {
      if (!result.ok) return
      setProfiles(result.value.profiles)
      setActiveId(result.value.activeId)
    })
  }, [])

  useEffect(load, [load])

  return (
    <div>
      <div className="flex flex-col gap-1.5">
        {profiles.map((profile) => {
          const isActive = profile.id === activeId
          return (
            <div
              key={profile.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-[var(--glass-edge)] px-2.5 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-xs">
                  {profile.name}
                  {isActive && (
                    <span className="ml-1.5 text-[10px] text-[var(--color-accent)]">in use</span>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {!isActive && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        void window.browser.invoke('profiles:switch', { id: profile.id })
                      }
                      className="cursor-default rounded border border-[var(--glass-edge)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    >
                      Switch
                    </button>
                    {profile.id !== 'default' && (
                      <button
                        type="button"
                        onClick={() => {
                          setProblem('')
                          void window.browser
                            .invoke('profiles:delete', { id: profile.id })
                            .then((result) => {
                              if (result.ok && !result.value.ok) setProblem(result.value.reason)
                              load()
                            })
                        }}
                        className="cursor-default rounded border border-[var(--glass-edge)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-warn)] hover:text-[var(--color-warn)]"
                      >
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {problem !== '' && (
        <p role="status" aria-live="polite" className="mt-1.5 text-[11px] text-[var(--color-warn)]">
          {problem}
        </p>
      )}

      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          if (newName.trim() === '') return
          void window.browser.invoke('profiles:create', { name: newName }).then(() => {
            setNewName('')
            load()
          })
        }}
      >
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="New profile name"
          aria-label="New profile name"
          className="min-w-0 flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="submit"
          disabled={newName.trim() === ''}
          className="shrink-0 cursor-default rounded-md border border-[var(--glass-edge)] px-2.5 py-1 text-xs transition hover:border-[var(--color-accent)] disabled:opacity-50"
        >
          Add profile
        </button>
      </form>

      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        A profile is a separate browser: its own history, bookmarks, passwords, settings, cookies
        and sign-ins. That is different from a <strong>workspace</strong>, which keeps tabs apart
        inside <em>your</em> browser and shares everything else.
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Switching restarts Slash. Only one profile runs at a time — the tabs you have open now will
        be restored the next time you come back to this one.
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-warn)]">
        Deleting a profile deletes everything in it, permanently.
      </p>
    </div>
  )
}
