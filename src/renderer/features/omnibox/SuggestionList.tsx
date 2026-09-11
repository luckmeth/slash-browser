import { useEffect, useState } from 'react'
import type { OmniboxState } from '@shared/types/omnibox'
import { Icon, type IconName } from '../../components/Icon'

const KIND_ICON: Record<string, IconName> = {
  navigate: 'globe',
  search: 'search',
  history: 'clock',
  bookmark: 'star',
  'open-tab': 'forward',
  // A book, not a clock: this row is "a page you read", matched on what was on
  // it. Sharing the history icon would hide the one thing that makes it
  // different from the row above it.
  memory: 'wsReading'
}

/**
 * The omnibox dropdown, rendered in the **overlay** document.
 *
 * It cannot live in the chrome document: the suggestion list hangs below the
 * toolbar and over the page, and the page is a native view composited above the
 * DOM, so a chrome-drawn list would be hidden behind it.
 *
 * Selection state stays in the chrome document — the arrow keys have to keep
 * working while the caret is still in the text field — and arrives here as a
 * pushed `omnibox:state`.
 */
export function SuggestionList(): React.JSX.Element | null {
  const [state, setState] = useState<OmniboxState | null>(null)

  useEffect(() => {
    // Pull first: the overlay's document loads asynchronously after `show()`, so
    // the state that triggered it was published before this listener existed.
    void window.browser.invoke('omnibox:getState', undefined).then((result) => {
      if (result.ok && result.value) setState(result.value)
    })
    return window.browser.on('omnibox:state', (next) => setState(next))
  }, [])

  if (!state || state.suggestions.length === 0) return null

  return (
    <div className="h-full w-full overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] py-1 shadow-2xl">
      <ul role="listbox" aria-label="Address suggestions">
        {state.suggestions.map((suggestion, index) => (
          <li key={suggestion.id}>
            <button
              type="button"
              role="option"
              aria-selected={index === state.selectedIndex}
              // Mouse down rather than click: the omnibox blurs on mousedown,
              // which would tear the dropdown down before a click landed.
              onMouseDown={(event) => {
                event.preventDefault()
                void window.browser.invoke('omnibox:accept', {
                  tabId: '',
                  suggestion
                })
              }}
              className={`flex w-full cursor-default items-center gap-3 px-3 py-2 text-left transition ${
                index === state.selectedIndex ? 'bg-white/10' : 'hover:bg-white/5'
              }`}
            >
              {suggestion.faviconUrl ? (
                <img
                  src={suggestion.faviconUrl}
                  width={32}
                  height={32}
                  alt=""
                  className="size-4 shrink-0 rounded-sm"
                  onError={(event) => {
                    event.currentTarget.style.visibility = 'hidden'
                  }}
                />
              ) : (
                <Icon
                  name={KIND_ICON[suggestion.kind] ?? 'globe'}
                  size={15}
                  className="shrink-0 text-[var(--color-text-muted)]"
                />
              )}

              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-[var(--color-text-primary)]">
                  {suggestion.title}
                </span>
                <span className="block truncate text-xs text-[var(--color-text-muted)]">
                  {suggestion.subtitle}
                </span>
              </span>

              {suggestion.kind === 'open-tab' && (
                <span className="shrink-0 rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                  open
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
