import { useCallback, useEffect, useMemo, useState } from 'react'

interface Shortcut {
  group: string
  label: string
  accelerator: string
}

/**
 * Every keyboard shortcut, on Ctrl+/.
 *
 * The list is **read out of the live application menu** rather than written
 * here. A hand-maintained sheet drifts the first time an accelerator is
 * reassigned — and this project has already reassigned four to resolve
 * collisions — at which point it teaches the wrong key and the user stops
 * trusting it. Deriving it means it cannot be wrong.
 *
 * Shortcuts were previously discoverable only by pressing Alt to reveal the menu
 * bar, which is not discovery so much as folklore.
 */
export function ShortcutSheet(): React.JSX.Element {
  const [shortcuts, setShortcuts] = useState<Shortcut[] | null>(null)
  const [query, setQuery] = useState('')

  const close = useCallback((): void => {
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }, [])

  useEffect(() => {
    void window.browser.invoke('shortcuts:list', undefined).then((result) => {
      if (result.ok) setShortcuts(result.value)
    })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matching = (shortcuts ?? []).filter(
      (row) =>
        q === '' ||
        row.label.toLowerCase().includes(q) ||
        row.accelerator.toLowerCase().includes(q)
    )
    const byGroup = new Map<string, Shortcut[]>()
    for (const row of matching) {
      const list = byGroup.get(row.group) ?? []
      list.push(row)
      byGroup.set(row.group, list)
    }
    return [...byGroup.entries()]
  }, [shortcuts, query])

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/45 p-6" onClick={close}>
      <div
        className="glass-float animate-rise flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--glass-edge)] px-4 py-3">
          <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter…"
            aria-label="Filter shortcuts"
            className="ml-auto w-40 rounded-md border border-[var(--glass-edge)] bg-black/20 px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
          />
          <kbd className="shrink-0 rounded border border-[var(--glass-edge)] bg-white/6 px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
            Esc
          </kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {shortcuts === null && (
            <p className="text-xs text-[var(--color-text-muted)]">Loading…</p>
          )}
          {shortcuts !== null && groups.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">
              Nothing matches “{query.trim()}”.
            </p>
          )}

          <div className="columns-1 gap-6 sm:columns-2">
            {groups.map(([group, rows]) => (
              <section key={group} className="mb-5 break-inside-avoid">
                <h3 className="mb-2 text-[10px] font-semibold tracking-[0.12em] text-[var(--color-text-muted)] uppercase">
                  {group}
                </h3>
                <ul className="flex flex-col gap-1">
                  {rows.map((row) => (
                    <li
                      key={`${group}-${row.label}-${row.accelerator}`}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="min-w-0 truncate text-[12px]">{row.label}</span>
                      <span className="flex shrink-0 gap-1">
                        {prettyKeys(row.accelerator).map((key) => (
                          <kbd
                            key={key}
                            className="rounded border border-[var(--glass-edge)] bg-white/6 px-1.5 py-0.5 font-sans text-[10px] text-[var(--color-text-muted)]"
                          >
                            {key}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Electron's accelerator string into keycap labels.
 *
 * `CommandOrControl` is the cross-platform spelling; on the machine this runs
 * on it is Ctrl, and showing the raw token would be noise.
 */
function prettyKeys(accelerator: string): string[] {
  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'CommandOrControl' || part === 'CmdOrCtrl') return 'Ctrl'
      if (part === 'Plus') return '+'
      return part
    })
    .filter((part) => part !== '')
}
