import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Tab } from '@shared/types/tab'
import type { Bookmark } from '@shared/types/browsing'
import type { UiCommand } from '@shared/ipc/contracts'
import { isInternalUrl } from '@shared/types/tab'
import { hostOf } from '@shared/url'
import { Icon, type IconName } from '../../components/Icon'

/**
 * One place to reach anything, on Ctrl+K.
 *
 * Distinct from tab search, which finds *tabs*. This also runs commands, so it
 * is the answer to "I know Slash does this and I cannot remember where it
 * lives" — the discoverability problem a browser with this many features has by
 * construction, and the reason the roadmap called it the biggest power-user win.
 *
 * Everything here already existed behind a menu item or a panel; nothing new is
 * reachable through it. That is deliberate — a palette that is the only route to
 * something has made the product harder to use, not easier.
 */

interface Entry {
  id: string
  icon: IconName
  label: string
  detail?: string
  group: 'Command' | 'Tab' | 'Bookmark'
  run: () => void
}

export function CommandPalette(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const close = useCallback((): void => {
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
    void window.browser.invoke('tabs:listAll', undefined).then((result) => {
      if (result.ok) setTabs(result.value.tabs)
    })
    void window.browser.invoke('bookmarks:list', undefined).then((result) => {
      if (result.ok) setBookmarks(result.value.filter((b) => !b.isFolder).slice(0, 200))
    })
  }, [])

  const entries = useMemo<Entry[]>(() => {
    const commands: Entry[] = [
      cmd('new-tab', 'plus', 'New tab', 'Ctrl+T', () =>
        window.browser.invoke('tabs:create', { url: undefined, background: false })
      ),
      cmd('split', 'wsFolder', 'Toggle split view', 'Ctrl+Shift+S', toggleSplit),
      panel('open-settings', 'settings', 'Open settings', 'Ctrl+,'),
      panel('open-history', 'clock', 'Open history', 'Ctrl+H'),
      panel('open-bookmarks', 'bookmarks', 'Open bookmarks', 'Ctrl+Shift+O'),
      panel('open-downloads', 'download', 'Open downloads', 'Ctrl+J'),
      panel('open-reading', 'star', 'Open reading list', 'Ctrl+Shift+D saves'),
      panel('open-performance', 'activity', 'Open performance', 'Ctrl+Shift+P'),
      panel('open-memory', 'sparkle', 'Open browsing memory'),
      panel('open-permissions', 'lock', 'Open permissions'),
      panel('open-timemachine', 'clock', 'Open restore points'),
      cmd('bookmark', 'star', 'Bookmark this tab', 'Ctrl+D', () =>
        window.browser.invoke('ui:run', { command: 'bookmark-current-tab' })
      ),
      cmd('save-reading', 'star', 'Save this tab to the reading list', 'Ctrl+Shift+D', () =>
        window.browser.invoke('ui:run', { command: 'save-to-reading' })
      )
    ]

    const tabEntries: Entry[] = tabs.map((tab) => ({
      id: `tab-${tab.id}`,
      icon: 'globe',
      label: tab.title || hostOf(tab.url) || 'Untitled',
      detail: isInternalUrl(tab.url) ? 'New tab' : hostOf(tab.url),
      group: 'Tab',
      run: () => void window.browser.invoke('tabs:activate', { tabId: tab.id })
    }))

    const bookmarkEntries: Entry[] = bookmarks.map((bookmark) => ({
      id: `bm-${bookmark.id}`,
      icon: 'bookmarks',
      label: bookmark.title || hostOf(bookmark.url ?? ''),
      detail: hostOf(bookmark.url ?? ''),
      group: 'Bookmark',
      run: () =>
        void window.browser.invoke('tabs:create', {
          url: bookmark.url ?? '',
          background: false
        })
    }))

    return [...commands, ...tabEntries, ...bookmarkEntries]
  }, [tabs, bookmarks])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return entries.slice(0, 12)
    return entries
      .filter((entry) => `${entry.label} ${entry.detail ?? ''}`.toLowerCase().includes(q))
      .slice(0, 12)
  }, [entries, query])

  // Clamped rather than reset: the highlight should stay put while the list
  // shrinks under it, not jump back to the top on every keystroke.
  const active = Math.min(selected, Math.max(0, matches.length - 1))

  const accept = (entry: Entry | undefined): void => {
    if (!entry) return
    entry.run()
    close()
  }

  return (
    <div className="fixed inset-0 flex items-start justify-center bg-black/40 p-6 pt-[14vh]" onClick={close}>
      <div
        className="glass-float animate-rise w-full max-w-xl overflow-hidden rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--glass-edge)] px-4 py-3">
          <Icon name="search" size={16} className="shrink-0 text-[var(--color-text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelected((n) => Math.min(n + 1, matches.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelected((n) => Math.max(n - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                accept(matches[active])
              }
            }}
            placeholder="Search commands, tabs and bookmarks"
            aria-label="Command palette"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--color-text-muted)]"
          />
          <kbd className="shrink-0 rounded border border-[var(--glass-edge)] bg-white/6 px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
            Esc
          </kbd>
        </div>

        {matches.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
            Nothing matches “{query.trim()}”.
          </p>
        ) : (
          <ul className="max-h-80 overflow-y-auto py-1.5">
            {matches.map((entry, index) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => accept(entry)}
                  className={`flex w-full cursor-default items-center gap-3 px-4 py-2 text-left transition ${
                    index === active ? 'bg-[var(--glass-high)]' : 'hover:bg-white/[0.06]'
                  }`}
                >
                  <Icon
                    name={entry.icon}
                    size={14}
                    className="shrink-0 text-[var(--color-text-muted)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{entry.label}</span>
                    {entry.detail && (
                      <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                        {entry.detail}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[10px] tracking-wide text-[var(--color-text-muted)] uppercase">
                    {entry.group}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function cmd(
  id: string,
  icon: IconName,
  label: string,
  detail: string | undefined,
  run: () => unknown
): Entry {
  return { id, icon, label, detail, group: 'Command', run: () => void run() }
}

/**
 * A command that opens one of the side panels.
 *
 * Routed through `ui:run` → main → `ui:command`, which is the same path a menu
 * accelerator takes. It cannot be a DOM event: this palette runs in the overlay
 * document and the panels are state in the chrome document — two separate
 * documents sharing no DOM, so an event dispatched here would reach nothing and
 * the command would silently do nothing at all.
 */
function panel(
  command: UiCommand['command'],
  icon: IconName,
  label: string,
  detail?: string
): Entry {
  return {
    id: `panel-${command}`,
    icon,
    label,
    detail,
    group: 'Command',
    run: () => void window.browser.invoke('ui:run', { command })
  }
}

/**
 * Splits with the neighbouring tab, or ends an existing split.
 *
 * Mirrors what the View menu does, rather than inventing a second rule for
 * which tab to pair with.
 */
async function toggleSplit(): Promise<void> {
  const snapshot = await window.browser.invoke('tabs:list', undefined)
  if (!snapshot.ok) return
  const { tabs, activeTabId, splitTabId } = snapshot.value
  if (splitTabId) {
    await window.browser.invoke('tabs:setSplit', { tabId: null })
    return
  }
  const index = tabs.findIndex((tab) => tab.id === activeTabId)
  const partner = tabs[index + 1] ?? tabs[index - 1]
  if (partner) await window.browser.invoke('tabs:setSplit', { tabId: partner.id })
}
