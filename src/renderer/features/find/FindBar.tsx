import { useEffect, useRef } from 'react'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

export const FIND_BAR_HEIGHT = 40

/**
 * Find-in-page.
 *
 * Rendered as a chrome row rather than floating over the page: a bar drawn in
 * this document would sit *underneath* the native page view. Opening it grows
 * the chrome, which insets the page downward — so the bar is always visible and
 * never covers the matches it is highlighting.
 */
export function FindBar(): React.JSX.Element | null {
  const findOpen = useBrowserStore((s) => s.findOpen)
  const findQuery = useBrowserStore((s) => s.findQuery)
  const setFindQuery = useBrowserStore((s) => s.setFindQuery)
  const closeFind = useBrowserStore((s) => s.closeFind)
  const activeTab = useBrowserStore((s) => s.activeTab())
  const inputRef = useRef<HTMLInputElement>(null)

  const tabId = activeTab?.id ?? null
  const result = activeTab?.findResult ?? null

  useEffect(() => {
    if (findOpen) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [findOpen])

  // Debounced so each keystroke does not restart the search from the top.
  useEffect(() => {
    if (!findOpen || !tabId) return
    const timer = setTimeout(() => {
      void window.browser.invoke('view:find', {
        tabId,
        text: findQuery,
        forward: true,
        findNext: false
      })
    }, 150)
    return () => clearTimeout(timer)
  }, [findQuery, findOpen, tabId])

  if (!findOpen) return null

  const step = (forward: boolean): void => {
    if (!tabId || !findQuery) return
    void window.browser.invoke('view:find', { tabId, text: findQuery, forward, findNext: true })
  }

  const noMatches = findQuery !== '' && result !== null && result.totalMatches === 0

  return (
    <div
      style={{ height: FIND_BAR_HEIGHT }}
      className="glass glass-divide-b flex shrink-0 items-center gap-2 px-3"
    >
      <div className="relative flex items-center">
        <input
          ref={inputRef}
          value={findQuery}
          onChange={(event) => setFindQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') step(!event.shiftKey)
            if (event.key === 'Escape') closeFind()
          }}
          placeholder="Find in page"
          aria-label="Find in page"
          className={`w-64 rounded-lg border bg-[var(--glass-raised)] px-2.5 py-1 text-sm outline-none ${
            noMatches
              ? 'border-[var(--color-bad)]'
              : 'border-[var(--color-border-subtle)] focus:border-[var(--color-accent)]'
          }`}
        />
      </div>

      <span
        className={`min-w-[68px] text-xs ${noMatches ? 'text-[var(--color-bad)]' : 'text-[var(--color-text-muted)]'}`}
        aria-live="polite"
      >
        {findQuery === ''
          ? ''
          : result === null
            ? 'Searching…'
            : result.totalMatches === 0
              ? 'No results'
              : `${result.activeMatch} of ${result.totalMatches}`}
      </span>

      <button
        type="button"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!result || result.totalMatches === 0}
        onClick={() => step(false)}
        className="cursor-default rounded p-1 text-[var(--color-text-muted)] transition hover:bg-white/10 hover:text-[var(--color-text-primary)] disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <Icon name="back" size={14} className="-rotate-90" />
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!result || result.totalMatches === 0}
        onClick={() => step(true)}
        className="cursor-default rounded p-1 text-[var(--color-text-muted)] transition hover:bg-white/10 hover:text-[var(--color-text-primary)] disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <Icon name="forward" size={14} className="rotate-90" />
      </button>

      <div className="flex-1" />

      <button
        type="button"
        aria-label="Close find bar"
        title="Close (Esc)"
        onClick={closeFind}
        className="cursor-default rounded p-1 text-[var(--color-text-muted)] transition hover:bg-white/10 hover:text-[var(--color-text-primary)]"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
