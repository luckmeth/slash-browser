import { useEffect, useState } from 'react'
import type { TabAnalysis } from '@shared/types/tabBrain'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * Autonomous Tab Brain.
 *
 * Shows the structure Slash found in the open tabs: probable projects,
 * duplicates, and tabs that look abandoned. Everything is computed locally from
 * titles and URLs, with no AI and nothing leaving the machine — stated in the
 * panel, because a feature that reads all your tab titles has to say where they
 * went.
 *
 * **Nothing here closes a tab on its own.** Suggestions are checkboxes that
 * start unchecked; the user selects and confirms. A tab may hold a half-filled
 * form, and no idle timer is a good enough reason to destroy it.
 */
export function TabBrainPanel(): React.JSX.Element {
  const [analysis, setAnalysis] = useState<TabAnalysis | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const tabs = useBrowserStore((s) => s.tabs)

  const analyse = (): void => {
    setBusy(true)
    void window.browser.invoke('tabBrain:analyse', undefined).then((result) => {
      setBusy(false)
      if (result.ok) {
        setAnalysis(result.value)
        setSelected(new Set())
      }
    })
  }

  // Re-analysed when the tab set changes, so the panel is never describing tabs
  // that are no longer open.
  useEffect(analyse, [tabs.length])

  const titleFor = (tabId: string): string => {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    return tab ? tab.title || hostOf(tab.url) : 'Closed tab'
  }

  const toggle = (tabId: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(tabId)) next.delete(tabId)
      else next.add(tabId)
      return next
    })
  }

  const closeSelected = (): void => {
    if (selected.size === 0) return
    setBusy(true)
    void window.browser
      .invoke('tabBrain:closeTabs', { tabIds: [...selected] })
      .then((result) => {
        setBusy(false)
        if (result.ok) {
          setAnalysis(result.value)
          setSelected(new Set())
        }
      })
  }

  const groupInto = (tabIds: string[], name: string): void => {
    setBusy(true)
    void window.browser
      .invoke('tabBrain:groupIntoWorkspace', { tabIds, name })
      .then(() => {
        setBusy(false)
        analyse()
      })
  }

  if (!analysis) {
    return (
      <p className="p-4 text-sm text-[var(--color-text-muted)]">
        {busy ? 'Reading your tabs…' : 'No analysis yet.'}
      </p>
    )
  }

  return (
    <div className="space-y-4 p-3">
      <div>
        <p className="text-xs text-[var(--color-text-muted)]">{analysis.summary}</p>
        <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
          Worked out on this machine from tab titles and addresses. No AI, nothing sent anywhere.
        </p>
      </div>

      {analysis.groups.length > 0 && (
        <section>
          <Heading>Probable projects</Heading>
          <ul className="space-y-2">
            {analysis.groups.map((group) => (
              <li
                key={group.id}
                className="rounded-lg border border-[var(--color-border-subtle)] p-2.5"
              >
                <p className="text-sm font-medium">{group.name}</p>
                <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{group.reason}</p>
                <ul className="mt-1.5 space-y-0.5">
                  {group.tabIds.slice(0, 6).map((tabId) => (
                    <li key={tabId} className="truncate text-[11px] text-[var(--color-text-muted)]">
                      · {titleFor(tabId)}
                    </li>
                  ))}
                  {group.tabIds.length > 6 && (
                    <li className="text-[11px] text-[var(--color-text-muted)]">
                      · and {group.tabIds.length - 6} more
                    </li>
                  )}
                </ul>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => groupInto(group.tabIds, group.name)}
                  className="mt-2 cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
                >
                  Move into a workspace
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis.duplicates.length > 0 && (
        <section>
          <Heading>Duplicates</Heading>
          <ul className="space-y-1.5">
            {analysis.duplicates.map((set) => (
              <li key={set.url} className="text-[11px] text-[var(--color-text-muted)]">
                <span className="text-[var(--color-text-primary)]">{set.tabIds.length}×</span>{' '}
                {set.title}
                {!set.exact && (
                  // Worth saying: different anchors of a long document may both
                  // genuinely be wanted.
                  <span className="ml-1 opacity-70">(same page, different link)</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis.closeSuggestions.length > 0 && (
        <section>
          <Heading>Safe to close</Heading>
          <ul className="space-y-1">
            {analysis.closeSuggestions.map((suggestion) => (
              <li key={suggestion.tabId}>
                <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={selected.has(suggestion.tabId)}
                    onChange={() => toggle(suggestion.tabId)}
                    className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-accent)]"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-xs">{suggestion.title}</span>
                    <span className="block text-[11px] text-[var(--color-text-muted)]">
                      {suggestion.reason}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <button
            type="button"
            disabled={selected.size === 0 || busy}
            onClick={closeSelected}
            className="mt-2 flex w-full cursor-default items-center justify-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-bad)] hover:text-[var(--color-bad)] disabled:opacity-40"
          >
            <Icon name="close" size={12} />
            {selected.size === 0
              ? 'Select tabs to close'
              : `Close ${selected.size} selected tab${selected.size === 1 ? '' : 's'}`}
          </button>
          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            Pinned tabs, tabs set to never sleep, and anything playing audio are never listed here.
          </p>
        </section>
      )}

      {analysis.groups.length === 0 &&
        analysis.duplicates.length === 0 &&
        analysis.closeSuggestions.length === 0 && (
          <p className="text-xs text-[var(--color-text-muted)]">
            Nothing to tidy. Slash found no duplicates, no abandoned tabs and no obvious projects.
          </p>
        )}

      <button
        type="button"
        disabled={busy}
        onClick={analyse}
        className="w-full cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
      >
        {busy ? 'Working…' : 'Re-analyse'}
      </button>
    </div>
  )
}

function Heading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
      {children}
    </h3>
  )
}
