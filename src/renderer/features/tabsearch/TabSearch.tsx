import { useEffect, useMemo, useRef, useState } from 'react'
import type { Tab } from '@shared/types/tab'
import type { Workspace } from '@shared/types/workspace'
import { hostOf } from '@shared/url'
import { Icon } from '../../components/Icon'

/**
 * Tab search — Ctrl+Shift+A.
 *
 * Past about fifteen tabs the strip stops being a way to find anything: titles
 * truncate to nothing and the tab you want is a guess. This searches **across
 * workspaces**, because a tab you cannot see is precisely the one you opened
 * this to find, and activating a result switches workspace on its own.
 *
 * Lives in the overlay document for the usual reason: it has to draw over page
 * content, and the page is a native view the chrome document cannot cover.
 */
export function TabSearch(): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.browser.invoke('tabs:listAll', undefined).then((result) => {
      if (!result.ok) return
      setTabs(result.value.tabs)
      setActiveId(result.value.activeTabId)
    })
    void window.browser.invoke('workspaces:list', undefined).then((result) => {
      if (result.ok) setWorkspaces(result.value.workspaces)
    })
    inputRef.current?.focus()
  }, [])

  const workspaceName = useMemo(() => {
    const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
    return (id: string): string => names.get(id) ?? ''
  }, [workspaces])

  const matches = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    // No query is not an empty state: it is "show me everything", which is the
    // fastest way to reach a tab whose title you cannot remember. Most recently
    // used first, so the tab you just left is the first thing offered.
    const ranked = [...tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    if (trimmed === '') return ranked.slice(0, 60)

    return ranked
      .filter((tab) =>
        `${tab.title} ${tab.url} ${workspaceName(tab.workspaceId)}`.toLowerCase().includes(trimmed)
      )
      .slice(0, 60)
  }, [tabs, query, workspaceName])

  const close = (): void => {
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }

  const activate = (tabId: string): void => {
    void window.browser.invoke('tabs:activate', { tabId }).then(close)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((current) => Math.min(current + 1, matches.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((current) => Math.max(current - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = matches[selected]
      if (target) activate(target.id)
    }
  }

  return (
    // A backdrop that closes on click: this is a picker, not a decision, so
    // clicking away must dismiss it rather than trap the user.
    <div
      className="flex h-full w-full items-start justify-center bg-black/40 pt-[12vh]"
      onClick={close}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[70vh] w-[min(640px,90vw)] flex-col overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2.5">
          <Icon name="search" size={14} className="shrink-0 text-[var(--color-text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search open tabs…"
            aria-label="Search open tabs"
            className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--color-text-muted)]"
          />
          <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
            {matches.length} of {tabs.length}
          </span>
        </div>

        {matches.length === 0 ? (
          <p className="p-4 text-sm text-[var(--color-text-muted)]">
            No open tab matches “{query.trim()}”.
          </p>
        ) : (
          <ul role="listbox" aria-label="Open tabs" className="min-h-0 flex-1 overflow-y-auto py-1">
            {matches.map((tab, index) => (
              <li key={tab.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => activate(tab.id)}
                  className={`flex w-full cursor-default items-center gap-2.5 px-3 py-2 text-left ${
                    index === selected ? 'bg-[var(--color-surface-hover)]' : ''
                  }`}
                >
                  {tab.faviconUrl ? (
                    <img
                      src={tab.faviconUrl}
                      alt=""
                      width={32}
                      height={32}
                      className="size-4 shrink-0 rounded-sm"
                    />
                  ) : (
                    <Icon
                      name="globe"
                      size={14}
                      className="shrink-0 text-[var(--color-text-muted)]"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{tab.title || hostOf(tab.url)}</span>
                    <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                      {hostOf(tab.url)}
                    </span>
                  </span>

                  {/* Only worth saying when it is somewhere else — labelling every
                      row with the workspace you are already in is noise. */}
                  {tab.workspaceId !== tabs.find((t) => t.id === activeId)?.workspaceId && (
                    <span className="shrink-0 rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                      {workspaceName(tab.workspaceId)}
                    </span>
                  )}
                  {/* Sleeping tabs are still findable here — that is the point
                      of them being asleep rather than closed. The moon says the
                      result will take a moment to come back. */}
                  {tab.status === 'hibernated' && (
                    <span className="shrink-0" title="Asleep — opening it wakes it up">
                      <Icon name="moon" size={12} className="text-[var(--color-text-muted)]" />
                    </span>
                  )}
                  {tab.id === activeId && (
                    <span className="shrink-0 text-[10px] text-[var(--color-accent)]">current</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
