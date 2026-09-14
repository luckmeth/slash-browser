import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Tab, ClosedTab } from '@shared/types/tab'
import type { Bookmark, HistoryEntry, DownloadItem } from '@shared/types/browsing'
import type { ReadingItem } from '@shared/types/readingList'
import type { Workspace } from '@shared/types/workspace'
import type { Snapshot } from '@shared/types/snapshot'
import type { MemoryResult } from '@shared/types/memory'
import type { UiCommand } from '@shared/ipc/contracts'
import { isInternalUrl } from '@shared/types/tab'
import { hostOf } from '@shared/url'
import {
  rankEntries,
  groupRanked,
  parseCommandQuery,
  splitOnMatches,
  GROUP_LABEL,
  SOURCE_FILTERS,
  type SearchableEntry
} from '@shared/commandSearch'
import { SETTINGS_TOPICS } from '@shared/settingsTopics'
import { findDuplicateGroups, duplicateCloseIds } from '@shared/tabDuplicates'
import { Icon, type IconName } from '../../components/Icon'

/**
 * One place to reach anything, on Ctrl+K.
 *
 * Distinct from tab search, which finds *tabs*. This searches everything the
 * browser holds — open tabs, recently closed ones, commands, bookmarks, the
 * reading list, workspaces, snapshots, history, downloads and indexed page text
 * — so it is the answer to "I know it is in here somewhere", which is the
 * discoverability problem a browser with this many features has by
 * construction.
 *
 * Everything here already existed behind a menu item or a panel; nothing new is
 * reachable through it. That is deliberate — a palette that is the only route to
 * something has made the product harder to use, not easier.
 *
 * The ranking is not in this file. `shared/commandSearch.ts` is pure and tested,
 * because the ordering across ten sources is a decision somebody made rather
 * than whatever order they happened to load in, and a decision like that is
 * worth being able to assert.
 */

interface Entry extends SearchableEntry {
  icon: IconName
  /** The shortcut or hint shown at the end of the row, where there is one. */
  hint?: string
  run: () => void
}

/**
 * How long to wait before asking main for history.
 *
 * History is the one source that is *not* held in memory here: it is unbounded,
 * so it is searched in SQLite rather than shipped to the overlay and filtered.
 * That means a round trip per keystroke without this, which principle 1 does not
 * allow on a box somebody is typing into.
 */
const HISTORY_DEBOUNCE_MS = 110

export function CommandPalette(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [tabs, setTabs] = useState<Tab[]>([])
  /** Split state, so the split commands appear only when they can act. */
  const [splitTabId, setSplitTabId] = useState<string | null>(null)
  const [splitOrientation, setSplitOrientation] = useState<'vertical' | 'horizontal'>('vertical')
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [reading, setReading] = useState<ReadingItem[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('')
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [closed, setClosed] = useState<ClosedTab[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [pages, setPages] = useState<MemoryResult[]>([])
  /**
   * Whether anything has been indexed to search.
   *
   * Both gates default off and CLAUDE.md is explicit that nothing indexes page
   * content without an opt-in already recorded in settings. Asking before
   * querying keeps the palette from reaching for an index the user never turned
   * on, and keeps an empty group from appearing as though the feature failed.
   */
  const [memoryEnabled, setMemoryEnabled] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const close = useCallback((): void => {
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
    void window.browser.invoke('tabs:listAll', undefined).then((result) => {
      if (result.ok) {
        setTabs(result.value.tabs)
        setSplitTabId(result.value.splitTabId)
        setSplitOrientation(result.value.splitOrientation)
      }
    })
    void window.browser.invoke('bookmarks:list', undefined).then((result) => {
      if (result.ok) setBookmarks(result.value.filter((b) => !b.isFolder).slice(0, 200))
    })
    void window.browser.invoke('reading:list', undefined).then((result) => {
      if (result.ok) setReading(result.value)
    })
    void window.browser.invoke('workspaces:list', undefined).then((result) => {
      if (result.ok) {
        setWorkspaces(result.value.workspaces)
        setActiveWorkspaceId(result.value.activeWorkspaceId)
      }
    })
    void window.browser.invoke('downloads:list', undefined).then((result) => {
      if (result.ok) setDownloads(result.value.slice(0, 100))
    })
    void window.browser.invoke('snapshots:list', undefined).then((result) => {
      if (result.ok) setSnapshots(result.value)
    })
    void window.browser.invoke('tabs:recentlyClosed', undefined).then((result) => {
      if (result.ok) setClosed(result.value)
    })
    void window.browser.invoke('settings:getAll', undefined).then((result) => {
      if (result.ok) setMemoryEnabled(result.value.indexHistory || result.value.indexPageContent)
    })
  }, [])

  /*
   * History, searched where it lives.
   *
   * Two guards, and both matter. The debounce keeps a keystroke from costing a
   * query; the sequence number keeps a slow reply for "gi" from landing after a
   * fast one for "github" and replacing the right answer with a stale one —
   * which looks exactly like the ranking being wrong.
   */
  const historySeq = useRef(0)
  useEffect(() => {
    const { kind, terms } = parseCommandQuery(query)
    // Below two characters every history row matches, which is noise rather
    // than an answer. `history:` on its own is a deliberate ask for the list,
    // so that one is honoured with no terms at all.
    if (kind !== 'history' && terms.length < 2) {
      setHistory([])
      return
    }

    const seq = ++historySeq.current
    const timer = setTimeout(() => {
      void window.browser
        .invoke('history:search', { query: terms, limit: 40, offset: 0 })
        .then((result) => {
          if (seq !== historySeq.current) return
          if (result.ok) setHistory(result.value)
        })
    }, HISTORY_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query])

  /*
   * The page-text index, on the same terms as history and for the same reasons.
   *
   * Local throughout: `memory:search` is FTS5 over text this browser extracted
   * and stored, plus the bundled embedding model when semantic search is on.
   * Nothing about the query or the result leaves the machine.
   */
  const memorySeq = useRef(0)
  useEffect(() => {
    const { kind, terms } = parseCommandQuery(query)
    if (!memoryEnabled || (kind !== 'memory' && terms.length < 3)) {
      setPages([])
      return
    }

    const seq = ++memorySeq.current
    const timer = setTimeout(() => {
      void window.browser.invoke('memory:search', { query: terms, limit: 12 }).then((result) => {
        if (seq !== memorySeq.current) return
        if (result.ok) setPages(result.value.results)
      })
    }, HISTORY_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query, memoryEnabled])

  /*
   * Duplicates, from the tab list already fetched.
   *
   * The same `findDuplicateGroups` the Tab Health view uses, so a count offered
   * here cannot disagree with the one offered there — and pinned and protected
   * copies are excluded by that rule rather than by a second one written here.
   */
  const duplicates = useMemo(
    () =>
      duplicateCloseIds(
        findDuplicateGroups(
          tabs.map((tab) => ({
            id: tab.id,
            url: tab.url,
            title: tab.title,
            lastActiveAt: tab.lastActiveAt,
            isPinned: tab.isPinned,
            isProtected: tab.isProtected
          }))
        )
      ),
    [tabs]
  )

  const entries = useMemo<Entry[]>(() => {
    const commands: Entry[] = [
      cmd('new-tab', 'plus', 'New tab', 'Ctrl+T', () =>
        window.browser.invoke('tabs:create', { url: undefined, background: false })
      ),
      cmd('split', 'wsFolder', 'Toggle split view', 'Ctrl+Shift+S', toggleSplit),
      // Only while a split is up: a command that cannot do what it says is the
      // same problem as a greyed menu item, and worse in a search box where
      // there is nothing to grey.
      ...(splitTabId
        ? [
            cmd('swap-split', 'expand', 'Swap the two panes', undefined, () =>
              window.browser.invoke('tabs:swapSplit', undefined)
            ),
            cmd('close-split', 'close', 'Close split view', undefined, () =>
              window.browser.invoke('tabs:setSplit', { tabId: null })
            ),
            cmd('split-orientation', 'expand', 'Stack the panes instead', 'Or side by side', () =>
              window.browser.invoke('tabs:setSplitOrientation', {
                orientation: splitOrientation === 'vertical' ? 'horizontal' : 'vertical'
              })
            )
          ]
        : []),
      cmd('reopen-closed', 'reload', 'Reopen the last closed tab', 'Ctrl+Shift+T', () =>
        window.browser.invoke('tabs:reopenClosed', undefined)
      ),
      ...(duplicates.length > 0
        ? [
            // A live command: it only exists when there is something to close,
            // and it names the count rather than offering a tidy-up that would
            // turn out to do nothing. The same shared rule the Tab Health view
            // uses, so the two cannot disagree about what a duplicate is.
            cmd(
              'close-duplicates',
              'trash',
              `Close ${duplicates.length} duplicate ${duplicates.length === 1 ? 'tab' : 'tabs'}`,
              'Keeps one of each · Ctrl+Shift+T undoes it',
              () => {
                for (const tabId of duplicates) {
                  void window.browser.invoke('tabs:close', { tabId })
                }
              }
            )
          ]
        : []),
      panel('open-settings', 'settings', 'Open settings', 'Ctrl+,'),
      panel('open-history', 'clock', 'Open history', 'Ctrl+H'),
      panel('open-bookmarks', 'bookmarks', 'Open bookmarks', 'Ctrl+Shift+O'),
      panel('open-downloads', 'download', 'Open downloads', 'Ctrl+J'),
      panel('open-reading', 'star', 'Open reading list'),
      panel('open-performance', 'activity', 'Open performance', 'Ctrl+Shift+P'),
      panel('open-protection', 'shield', 'What Slash did this week', 'Protection report'),
      panel('open-trust', 'lock', 'Site trust for this page', 'What Slash knows about it'),
      panel('open-compare', 'expand', 'Compare open pages', 'Side by side, read locally'),
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

    const workspaceName = new Map(workspaces.map((w) => [w.id, w.name]))

    const tabEntries: Entry[] = tabs.map((tab) => ({
      id: `tab-${tab.id}`,
      kind: 'tab',
      icon: 'globe',
      label: tab.title || hostOf(tab.url) || 'Untitled',
      // A tab in another workspace is still reachable — activating it switches
      // workspace — so say which one, or arriving somewhere else is a surprise.
      detail:
        (isInternalUrl(tab.url) ? 'New tab' : hostOf(tab.url)) +
        (tab.workspaceId !== activeWorkspaceId
          ? ` · in ${workspaceName.get(tab.workspaceId) ?? 'another workspace'}`
          : ''),
      // Says what Enter will do, and that it will not open a second copy of a
      // page that is already open — the one thing a search box over tabs and
      // history has to get right.
      hint: 'Switch to tab',
      run: () => void window.browser.invoke('tabs:activate', { tabId: tab.id })
    }))

    const bookmarkEntries: Entry[] = bookmarks.map((bookmark) => ({
      id: `bm-${bookmark.id}`,
      kind: 'bookmark',
      icon: 'bookmarks',
      label: bookmark.title || hostOf(bookmark.url ?? ''),
      detail: hostOf(bookmark.url ?? ''),
      run: () => openUrl(bookmark.url ?? '')
    }))

    const readingEntries: Entry[] = reading.map((item) => ({
      id: `read-${item.id}`,
      kind: 'reading',
      icon: 'star',
      label: item.title || hostOf(item.url),
      detail: hostOf(item.url),
      hint: item.readAt === null ? undefined : 'Read',
      run: () => openUrl(item.url)
    }))

    const workspaceEntries: Entry[] = workspaces.map((workspace) => ({
      id: `ws-${workspace.id}`,
      kind: 'workspace',
      icon: workspace.icon,
      label: workspace.name,
      // The notes when there are any, so a workspace can be found by what it is
      // for rather than only by what it was called.
      detail:
        workspace.notes.trim() !== ''
          ? workspace.notes.trim().replace(/\s+/g, ' ').slice(0, 120)
          : workspace.isolated
            ? 'Isolated workspace'
            : 'Workspace',
      hint: workspace.id === activeWorkspaceId ? 'Current' : undefined,
      run: () => void window.browser.invoke('workspaces:activate', { id: workspace.id })
    }))

    const downloadEntries: Entry[] = downloads.map((item) => ({
      id: `dl-${item.id}`,
      kind: 'download',
      icon: 'download',
      label: item.filename,
      detail: hostOf(item.url),
      hint: item.state === 'completed' ? undefined : item.state,
      // A finished file opens. Anything else has no file to open yet, so the
      // honest outcome is the panel that shows what it is waiting on rather
      // than a click that appears to do nothing.
      run: () =>
        void (item.state === 'completed'
          ? window.browser.invoke('downloads:openFile', { id: item.id })
          : window.browser.invoke('ui:run', { command: 'open-downloads' }))
    }))

    const settingEntries: Entry[] = SETTINGS_TOPICS.map((topic) => ({
      id: `set-${topic.title}`,
      kind: 'setting',
      icon: 'settings',
      label: topic.title,
      // The words people actually reach for. Searchable because `scoreEntry`
      // reads the detail line, and shown because a row matching on a word that
      // is nowhere on it looks like a mistake.
      detail: topic.keywords,
      hint: 'Open in settings',
      run: () =>
        void window.browser.invoke('ui:run', { command: 'open-settings', arg: topic.title })
    }))

    const closedEntries: Entry[] = closed.map((entry) => ({
      id: `closed-${entry.id}`,
      kind: 'closed',
      icon: 'reload',
      label: entry.title || hostOf(entry.url),
      detail: hostOf(entry.url),
      hint: 'Reopen',
      // By the stored row's id, not by address. Reopening rebuilds the tab with
      // its back/forward history, which the closed-tab record holds and this
      // renderer deliberately never sees — creating a new tab at the same URL
      // would look identical and lose everywhere that tab had been.
      run: () => void window.browser.invoke('tabs:reopenClosedAt', { id: entry.id })
    }))

    const snapshotEntries: Entry[] = snapshots.map((snapshot) => ({
      id: `snap-${snapshot.id}`,
      kind: 'snapshot',
      icon: 'clock',
      label: snapshot.label,
      detail: `${snapshot.tabCount} tab${snapshot.tabCount === 1 ? '' : 's'} · ${dateOf(snapshot.createdAt)}`,
      // Opens the restore-points screen rather than restoring from here.
      // Restoring a snapshot reopens a whole session, which is not something a
      // list of search results should do on one keystroke with no preview.
      hint: 'Open restore points',
      run: () => void window.browser.invoke('ui:run', { command: 'open-timemachine' })
    }))

    const historyEntries: Entry[] = history.map((item) => ({
      id: `hist-${item.id}`,
      kind: 'history',
      icon: 'clock',
      label: item.title || hostOf(item.url),
      // The address rather than the host: main matched on the whole URL, so a
      // row found by its path reads as a match here too rather than looking
      // like a result that arrived for no reason.
      detail: withoutScheme(item.url),
      alreadyMatched: true,
      run: () => openUrl(item.url)
    }))

    const pageEntries: Entry[] = pages.map((page) => ({
      id: `mem-${page.pageId}`,
      kind: 'memory',
      icon: 'sparkle',
      label: page.title || hostOf(page.url),
      // The passage that matched, which is the only reason this row is here.
      detail: page.snippet.replace(/\s+/g, ' ').slice(0, 140),
      alreadyMatched: true,
      run: () => openUrl(page.url)
    }))

    return [
      ...commands,
      ...tabEntries,
      ...bookmarkEntries,
      ...readingEntries,
      ...workspaceEntries,
      ...settingEntries,
      ...closedEntries,
      ...snapshotEntries,
      ...downloadEntries,
      ...historyEntries,
      ...pageEntries
    ]
  }, [
    duplicates,
    splitTabId,
    splitOrientation,
    tabs,
    bookmarks,
    reading,
    workspaces,
    activeWorkspaceId,
    closed,
    snapshots,
    downloads,
    history,
    pages
  ])

  const matches = useMemo(() => rankEntries(entries, query, 40), [entries, query])
  const groups = useMemo(() => groupRanked(matches), [matches])
  // What to mark up in each row: the terms with any filter prefix removed, or
  // `history:` would be highlighted in every history row it just selected.
  const terms = useMemo(() => parseCommandQuery(query).terms, [query])

  // Clamped rather than reset: the highlight should stay put while the list
  // shrinks under it, not jump back to the top on every keystroke.
  const active = Math.min(selected, Math.max(0, matches.length - 1))

  // With seven sources the list is long enough to scroll, so moving the
  // highlight below the fold has to bring it into view or the arrow keys appear
  // to stop working.
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const accept = (entry: Entry | undefined): void => {
    if (!entry) return
    entry.run()
    close()
  }

  let row = -1

  return (
    <div
      className="fixed inset-0 flex items-start justify-center bg-black/40 p-6 pt-[14vh]"
      onClick={close}
    >
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
            placeholder="Search tabs, history, bookmarks, downloads and commands"
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
          <div ref={listRef} className="max-h-[22rem] overflow-y-auto py-1.5">
            {groups.map((group) => (
              <section key={group.kind}>
                <h2 className="px-4 pt-2 pb-1 text-[10px] font-medium tracking-wide text-[var(--color-text-muted)] uppercase">
                  {GROUP_LABEL[group.kind]}
                </h2>
                <ul>
                  {group.entries.map((entry) => {
                    row += 1
                    const index = row
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          data-row={index}
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
                            <span className="block truncate text-[13px]">
                              <Highlight text={entry.label} terms={terms} />
                            </span>
                            {entry.detail && (
                              <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                                <Highlight text={entry.detail} terms={terms} />
                              </span>
                            )}
                          </span>
                          {entry.hint && (
                            <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                              {entry.hint}
                            </span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {/*
          The filters, where somebody will see them. They are the difference
          between a box that finds the wrong kind of thing and one that can be
          aimed, and nobody discovers a prefix syntax by guessing at it.
        */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--glass-edge)] px-4 py-2 text-[10px] text-[var(--color-text-muted)]">
          <span>Narrow with</span>
          {SOURCE_FILTERS.map((filter) => (
            <button
              key={filter.prefix}
              type="button"
              onClick={() => {
                setQuery(filter.prefix)
                setSelected(0)
                inputRef.current?.focus()
              }}
              className="cursor-default rounded border border-[var(--glass-edge)] px-1.5 py-0.5 transition hover:bg-white/[0.08]"
            >
              {filter.prefix}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * A label with the matched characters marked.
 *
 * The pieces come from `splitOnMatches`, which derives them from the same rules
 * the ranking used — so the marks cannot point somewhere the matcher never
 * looked, and a row that ranked for a reason this module cannot show (a stemmed
 * FTS hit) renders plain rather than with something invented.
 */
function Highlight({ text, terms }: { text: string; terms: string }): React.JSX.Element {
  const parts = useMemo(() => splitOnMatches(text, terms), [text, terms])
  return (
    <>
      {parts.map((part, index) =>
        part.matched ? (
          <mark
            key={index}
            className="bg-transparent font-semibold text-[var(--color-accent)]"
          >
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </>
  )
}

/** A snapshot's date, in the browser's own locale rather than a fixed format. */
function dateOf(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function openUrl(url: string): void {
  if (url === '') return
  void window.browser.invoke('tabs:create', { url, background: false })
}

/** What a history row reads as. The scheme is noise in a list of addresses. */
function withoutScheme(url: string): string {
  return url.replace(/^https?:\/\//, '')
}

function cmd(
  id: string,
  icon: IconName,
  label: string,
  hint: string | undefined,
  run: () => unknown
): Entry {
  return { id, kind: 'command', icon, label, hint, run: () => void run() }
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
  hint?: string
): Entry {
  return {
    id: `panel-${command}`,
    kind: 'command',
    icon,
    label,
    hint,
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
  // One call. Choosing the partner used to happen here — take the next tab,
  // whatever it is — and a tab showing the new tab page has no page view to
  // composite, so the split laid out and dropped itself while this function
  // threw the result away. Main picks a tab that can actually be shown, and
  // says so when there is none.
  await window.browser.invoke('tabs:toggleSplit', undefined)
}
