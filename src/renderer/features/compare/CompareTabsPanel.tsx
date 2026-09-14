import { useMemo, useState } from 'react'
import type { PageFacts } from '@shared/compareTabs'
import {
  alignFacts,
  NO_FIELDS_NOTE,
  MAX_COMPARE_TABS,
  MIN_COMPARE_TABS
} from '@shared/compareTabs'
import { isInternalUrl } from '@shared/types/tab'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'

interface Unreadable {
  tabId: string
  title: string
  reason: string
}

/**
 * Compare two or more open pages, side by side.
 *
 * Everything shown is something a page stated about itself — structured data, a
 * specification table, a meta tag. Nothing is inferred from prose and no model
 * is asked, so a cell is either a value or the words **Not detected**. The spec
 * this was built to is explicit that the second is the better answer, and it is:
 * a comparison table is exactly where an invented number does the most damage.
 *
 * The pages are read on this click and not before. No page is woken to be read.
 */
export function CompareTabsPanel(): React.JSX.Element {
  const tabs = useBrowserStore((s) => s.tabs)
  const activeTabId = useBrowserStore((s) => s.activeTabId)

  const comparable = useMemo(() => tabs.filter((tab) => !isInternalUrl(tab.url)), [tabs])

  const [selected, setSelected] = useState<string[]>(() =>
    activeTabId && comparable.some((tab) => tab.id === activeTabId) ? [activeTabId] : []
  )
  const [facts, setFacts] = useState<PageFacts[] | null>(null)
  const [unreadable, setUnreadable] = useState<Unreadable[]>([])
  const [busy, setBusy] = useState(false)

  const comparison = useMemo(() => (facts ? alignFacts(facts) : null), [facts])

  const toggle = (tabId: string): void => {
    setSelected((current) => {
      if (current.includes(tabId)) return current.filter((id) => id !== tabId)
      // Capped rather than silently ignoring the click: four columns is already
      // more than a side panel can show without becoming unreadable.
      if (current.length >= MAX_COMPARE_TABS) return current
      return [...current, tabId]
    })
  }

  const compare = (): void => {
    if (selected.length < MIN_COMPARE_TABS) return
    setBusy(true)
    void window.browser.invoke('compare:tabs', { tabIds: selected }).then((result) => {
      setBusy(false)
      if (!result.ok) return
      setFacts(result.value.facts)
      setUnreadable(result.value.unreadable)
    })
  }

  const titleFor = (tabId: string): string => {
    const page = facts?.find((fact) => fact.tabId === tabId)
    if (page) return page.title || hostOf(page.url)
    const tab = tabs.find((t) => t.id === tabId)
    return tab?.title || hostOf(tab?.url ?? '') || 'Tab'
  }

  if (comparable.length < MIN_COMPARE_TABS) {
    return (
      <p className="p-4 text-sm text-[var(--color-text-muted)]">
        Open at least two pages to compare them. Internal pages are not included — there is nothing
        on them to read.
      </p>
    )
  }

  return (
    <div className="space-y-4 p-4">
      <div>
        <h3 className="text-sm font-semibold">Compare pages</h3>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
          Pick {MIN_COMPARE_TABS}–{MAX_COMPARE_TABS} open pages. Slash reads what each one states
          about itself — nothing is fetched, and nothing is guessed.
        </p>
      </div>

      <ul className="space-y-1">
        {comparable.map((tab) => {
          const checked = selected.includes(tab.id)
          return (
            <li key={tab.id}>
              <label className="flex cursor-default items-center gap-2 rounded-md border border-[var(--color-border-subtle)] p-2 text-xs">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && selected.length >= MAX_COMPARE_TABS}
                  onChange={() => toggle(tab.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{tab.title || hostOf(tab.url)}</span>
                  <span className="block truncate text-[var(--color-text-muted)]">
                    {hostOf(tab.url)}
                  </span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>

      <button
        type="button"
        onClick={compare}
        disabled={selected.length < MIN_COMPARE_TABS || busy}
        className="w-full cursor-pointer rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-black transition hover:opacity-90 disabled:cursor-default disabled:opacity-50"
      >
        {busy ? 'Reading…' : `Compare ${selected.length || ''} selected`.trim()}
      </button>

      {unreadable.length > 0 && (
        <ul className="space-y-1">
          {unreadable.map((item) => (
            <li
              key={item.tabId}
              className="rounded-md border border-dashed border-[var(--color-border-subtle)] p-2 text-xs text-[var(--color-text-muted)]"
            >
              <span className="block truncate">{item.title}</span>
              {/* Named rather than dropped: a column missing from a comparison
                  somebody asked for looks like a fault in the browser. */}
              <span>{item.reason}</span>
            </li>
          ))}
        </ul>
      )}

      {comparison && (
        <section>
          {comparison.empty ? (
            <p className="rounded-lg border border-[var(--color-border-subtle)] p-3 text-xs text-[var(--color-text-muted)]">
              {NO_FIELDS_NOTE}
            </p>
          ) : (
            // Its own scroller: a comparison with four columns is wider than a
            // 380px panel, and the page beneath must not scroll sideways.
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    <th className="border-b border-[var(--color-border-subtle)] p-1.5 text-left font-medium text-[var(--color-text-muted)]">
                      Field
                    </th>
                    {comparison.pages.map((page) => (
                      <th
                        key={page.tabId}
                        className="max-w-[9rem] border-b border-[var(--color-border-subtle)] p-1.5 text-left font-medium"
                        title={page.url}
                      >
                        <span className="block truncate">{titleFor(page.tabId)}</span>
                        <span className="block truncate font-normal text-[var(--color-text-muted)]">
                          {hostOf(page.url)}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparison.rows.map((row) => (
                    <tr key={row.field} className={row.differs ? 'bg-[var(--glass-high)]' : ''}>
                      <th className="p-1.5 text-left font-normal text-[var(--color-text-muted)]">
                        {row.field}
                      </th>
                      {row.cells.map((cell) => (
                        <td key={cell.tabId} className="max-w-[9rem] p-1.5 align-top">
                          {cell.value ?? (
                            <span className="text-[var(--color-text-muted)] italic">
                              Not detected
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            “Not detected” means the page did not state it anywhere Slash looks — structured data, a
            meta tag or a two-column table. It is not a claim about the product.
          </p>

          {/* The side-by-side view, which is what the spec asks for when
              structured extraction finds nothing — and is useful alongside it. */}
          <div className="mt-3 space-y-2">
            {comparison.pages.map((page) => (
              <div
                key={page.tabId}
                className="rounded-lg border border-[var(--color-border-subtle)] p-2.5"
              >
                <p className="truncate text-xs font-medium" title={page.url}>
                  {page.title || hostOf(page.url)}
                </p>
                {page.description && (
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">{page.description}</p>
                )}
                <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                  {page.wordCount.toLocaleString()} words
                  {page.headings.length > 0 && ` · ${page.headings.length} headings`}
                  {page.siteName && ` · ${page.siteName}`}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
