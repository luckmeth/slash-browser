import { useEffect, useRef, useState } from 'react'
import {
  SUGGESTION_ROW_HEIGHT,
  SUGGESTION_LIST_PADDING,
  type Suggestion
} from '@shared/types/omnibox'
import { isInternalUrl, NEW_TAB_URL } from '@shared/types/tab'
import { formatUrlForDisplay, isSecureUrl } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'
import { CleanButton } from '../cleanup/CleanButton'
import { ShieldButton } from '../shield/ShieldButton'
import { PasswordFillButton } from '../passwords/PasswordFillButton'
import { SleepIndicator } from '../performance/SleepIndicator'

export function Toolbar(): React.JSX.Element {
  const activeTab = useBrowserStore((s) => s.activeTab())
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const panel = useBrowserStore((s) => s.panel)
  const togglePanel = useBrowserStore((s) => s.togglePanel)
  const setPanel = useBrowserStore((s) => s.setPanel)
  const detectedMedia = useBrowserStore((s) => s.detectedMedia)
  const [assistantNote, setAssistantNote] = useState<string | null>(null)
  // The `?? []` MUST stay outside the selector. Zustand compares what a
  // selector returns with Object.is, so a selector that builds a fresh array
  // every call never compares equal — it re-renders, re-selects, and loops
  // forever. That is React error #185, and it hung the whole chrome renderer.
  const hiddenButtons = useBrowserStore((s) => s.settings?.hiddenToolbarButtons)
  /** A deny-list, so a button added later shows up rather than being invisible. */
  const shown = (id: string): boolean => !(hiddenButtons ?? []).includes(id)
  const focusToken = useBrowserStore((s) => s.focusOmniboxToken)

  const inputRef = useRef<HTMLInputElement>(null)
  const fieldRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  /** Set when reader mode declined a page, cleared after a few seconds. */
  const [readerNote, setReaderNote] = useState<string | null>(null)
  const tabId = activeTab?.id ?? null
  const url = activeTab?.url ?? ''
  const isNewTab = url === NEW_TAB_URL

  // While the user is typing, `draft` owns the field. Clearing it on tab switch
  // or navigation is what stops a half-typed address leaking into another tab.
  useEffect(() => {
    setDraft(null)
    setSuggestions([])
  }, [tabId, url])

  // Fetch suggestions as the user types. Debounced, because each keystroke
  // otherwise runs a LIKE query and rebuilds the ranking.
  useEffect(() => {
    if (draft === null || draft.trim() === '') {
      setSuggestions([])
      return
    }
    const timer = setTimeout(() => {
      void window.browser.invoke('omnibox:suggest', { query: draft }).then((result) => {
        if (result.ok) {
          setSuggestions(result.value)
          setSelectedIndex(0)
        }
      })
    }, 90)
    return () => clearTimeout(timer)
  }, [draft])

  /**
   * Publish the dropdown to the overlay, positioned under the field.
   *
   * The list is measured here rather than in the overlay because only this
   * document knows where the omnibox actually is, and the overlay must be sized
   * to the list — a larger rect would swallow clicks on the page behind it.
   */
  useEffect(() => {
    const field = fieldRef.current
    if (!field) return

    if (suggestions.length === 0) {
      void window.browser.invoke('omnibox:dismiss', undefined)
      return
    }

    const rect = field.getBoundingClientRect()
    const height =
      suggestions.length * SUGGESTION_ROW_HEIGHT + SUGGESTION_LIST_PADDING * 2
    void window.browser.invoke('omnibox:setState', {
      query: draft ?? '',
      suggestions,
      selectedIndex,
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.bottom + 4),
        width: Math.round(rect.width),
        height: Math.round(height)
      }
    })
  }, [suggestions, selectedIndex, draft])

  useEffect(() => {
    if (focusToken === 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])

  const displayed = draft ?? (isNewTab ? '' : formatUrlForDisplay(url))
  const bookmarked = bookmarks.some((b) => !b.isFolder && b.url === url)
  // Chromium zoom levels are logarithmic: each step multiplies by 1.2.
  const zoomPercent = Math.round(1.2 ** (activeTab?.zoomLevel ?? 0) * 100)

  async function submit(): Promise<void> {
    if (!tabId || draft === null) return

    // Enter takes the highlighted suggestion. The first row is always the
    // literal reading of what was typed, so pressing Enter immediately does
    // exactly what the field says — never a surprise redirect to a history hit.
    const chosen = suggestions[selectedIndex]
    setSuggestions([])
    if (chosen) {
      await window.browser.invoke('omnibox:accept', { tabId, suggestion: chosen })
    } else {
      await window.browser.invoke('nav:navigate', { tabId, input: draft })
    }
    setDraft(null)
    inputRef.current?.blur()
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      void submit()
      return
    }
    if (event.key === 'Escape') {
      setDraft(null)
      setSuggestions([])
      inputRef.current?.blur()
      return
    }
    if (suggestions.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex((i) => (i + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
    }
  }

  async function toggleBookmark(): Promise<void> {
    if (!activeTab || isInternalUrl(activeTab.url)) return
    const existing = bookmarks.find((b) => !b.isFolder && b.url === activeTab.url)
    if (existing) {
      await window.browser.invoke('bookmarks:delete', { id: existing.id })
    } else {
      await window.browser.invoke('bookmarks:create', {
        url: activeTab.url,
        title: activeTab.title || activeTab.url,
        faviconUrl: activeTab.faviconUrl,
        parentId: null,
        isFolder: false
      })
    }
  }

  const disabled = !tabId

  return (
    <div className="flex items-center gap-1 px-2 py-1.5">
      <NavButton
        icon="back"
        label="Back (Alt+Left)"
        disabled={disabled || !activeTab?.canGoBack}
        onClick={() => tabId && void window.browser.invoke('nav:goBack', { tabId })}
      />
      <NavButton
        icon="forward"
        label="Forward (Alt+Right)"
        disabled={disabled || !activeTab?.canGoForward}
        onClick={() => tabId && void window.browser.invoke('nav:goForward', { tabId })}
      />
      <NavButton
        icon={activeTab?.isLoading ? 'stop' : 'reload'}
        label={activeTab?.isLoading ? 'Stop (Esc)' : 'Reload (Ctrl+R)'}
        disabled={disabled || isNewTab}
        onClick={() => {
          if (!tabId) return
          if (activeTab?.isLoading) void window.browser.invoke('nav:stop', { tabId })
          else void window.browser.invoke('nav:reload', { tabId, ignoreCache: false })
        }}
      />

      <div ref={fieldRef} className="relative mx-1 flex flex-1 items-center">
        <span className="pointer-events-none absolute left-3 text-[var(--color-text-muted)]">
          {isNewTab ? (
            <Icon name="search" size={14} />
          ) : isSecureUrl(url) ? (
            <Icon name="lock" size={14} className="text-[var(--color-good)]" />
          ) : (
            <Icon name="globe" size={14} />
          )}
        </span>

        <input
          ref={inputRef}
          value={displayed}
          disabled={disabled}
          spellCheck={false}
          placeholder="Search or enter address"
          aria-label="Address and search bar"
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => {
            // Reveal the full URL for editing; the collapsed form is for reading.
            if (draft === null && !isNewTab) setDraft(url)
            event.target.select()
          }}
          onBlur={() => {
            setDraft(null)
            setSuggestions([])
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          // Deliberately no aria-controls / aria-activedescendant. The suggestion
          // list lives in the overlay, which is a **separate WebContents with its
          // own document** — an id reference cannot cross that boundary, so
          // pointing at "omnibox-suggestions" declared a relationship that
          // silently resolved to nothing. The live region below carries the same
          // information by the only route that actually works here.
          aria-autocomplete="list"
          className="w-full rounded-xl border border-[var(--glass-edge)] bg-[var(--glass-raised)] py-1.5 pr-9 pl-9 text-sm outline-none transition focus:border-[var(--color-accent)] focus:bg-[var(--glass-high)] disabled:opacity-50"
        />

        {/*
          What the suggestion list would have announced, had ARIA been able to
          reach it. Announces the highlighted row as the user arrows through,
          because a screen reader cannot see the overlay document from here.
        */}
        <div className="sr-only" role="status" aria-live="polite">
          {suggestions.length === 0
            ? ''
            : `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}`}
        </div>

        <div className="absolute right-1.5 flex items-center gap-0.5">
          {/* Only shown when zoom is not 100%, as Chrome does — a permanent
              indicator would be noise on every page. */}
          {zoomPercent !== 100 && tabId && (
            <button
              type="button"
              title={`Zoom ${zoomPercent}% — click to reset (Ctrl+0)`}
              aria-label={`Zoom ${zoomPercent} percent, click to reset`}
              onClick={() => void window.browser.invoke('view:setZoomLevel', { tabId, level: 0 })}
              className="cursor-default rounded px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-accent)] transition hover:bg-white/10"
            >
              {zoomPercent}%
            </button>
          )}

          {/*
            Reader mode. Whether a page is an article can only be known by
            extracting it, which is far too expensive to do on every page load
            just to decide whether to enable a button — so the button is always
            offered and answers honestly when the page turns out not to be one.
          */}
          <CleanButton />

          <button
            type="button"
            aria-label="Read this page without the clutter"
            title={readerNote ?? 'Reader mode — just the article text'}
            disabled={disabled || isInternalUrl(url)}
            onClick={() => {
              setReaderNote(null)
              void window.browser.invoke('reader:open', undefined).then((result) => {
                if (result.ok && !result.value.article) {
                  setReaderNote(result.value.reason)
                  window.setTimeout(() => setReaderNote(null), 4000)
                }
              })
            }}
            className="cursor-default rounded p-1 transition hover:bg-white/10 disabled:cursor-default disabled:opacity-30"
          >
            <Icon
              name="wsReading"
              size={14}
              className={
                readerNote ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-muted)]'
              }
            />
          </button>

          <button
            type="button"
            aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this tab (Ctrl+D)'}
            title={bookmarked ? 'Remove bookmark' : 'Bookmark this tab (Ctrl+D)'}
            disabled={disabled || isInternalUrl(url)}
            onClick={() => void toggleBookmark()}
            className="cursor-default rounded p-1 transition hover:bg-white/10 disabled:cursor-default disabled:opacity-30"
          >
            <Icon
              name="star"
              size={14}
              filled={bookmarked}
              className={
                bookmarked ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'
              }
            />
          </button>
        </div>
      </div>

      <SleepIndicator />

      <ShieldButton />

      {/* Only present when the page actually has a sign-in form. */}
      <PasswordFillButton />

      {/* Hideable buttons. Each keeps its keyboard shortcut and menu entry when
          hidden — this is about clutter, not capability. Settings is never
          hideable: it is the only route back to un-hiding the rest. */}
      {shown('external') && (
        <NavButton
          icon="external"
          label="Open this page in your default browser"
          disabled={disabled || isNewTab}
          onClick={() => tabId && void window.browser.invoke('shell:openTabExternally', { tabId })}
        />
      )}

      {shown('reading') && (
        <NavButton
          icon="star"
          label="Reading list"
          active={panel === 'reading'}
          onClick={() => togglePanel('reading')}
        />
      )}
      {shown('bookmarks') && (
        <NavButton
          icon="bookmarks"
          label="Bookmarks (Ctrl+Shift+O)"
          active={panel === 'bookmarks'}
          onClick={() => togglePanel('bookmarks')}
        />
      )}
      {shown('history') && (
        <NavButton
          icon="clock"
          label="History (Ctrl+H)"
          active={panel === 'history'}
          onClick={() => togglePanel('history')}
        />
      )}
      {shown('assistant') && (
        <NavButton
          icon="sparkle"
          label="Assistant beside page (Ctrl+Shift+L)"
          onClick={() => {
            void window.browser.invoke('assistant:toggle', undefined).then((result) => {
              // A window too narrow for two panes is the one real failure here,
              // and silence would get the button reported as broken.
              if (result.ok && !result.value.ok && result.value.reason) {
                setAssistantNote(result.value.reason)
                setTimeout(() => setAssistantNote(null), 5000)
              }
            })
          }}
        />
      )}
      {/* Inline rather than a floating toast: a notice drawn under the
          toolbar would sit beneath the page view, which is a native layer, and
          be invisible exactly when it matters. */}
      {assistantNote !== null && (
        <span
          role="status"
          className="max-w-[18rem] truncate rounded-md bg-white/10 px-2 py-1 text-[11px] text-[var(--color-text-muted)]"
        >
          {assistantNote}
        </span>
      )}
      {shown('downloads') && (
        <NavButton
          icon="download"
          label="Downloads (Ctrl+J)"
          active={panel === 'downloads'}
          onClick={() => togglePanel('downloads')}
        />
      )}
      {/* Only while this tab actually has something downloadable. A permanent
          button that is usually useless teaches people to ignore it, and this
          one is only worth anything when it appears. */}
      {detectedMedia > 0 && (
        <button
          type="button"
          title={`Download video (${detectedMedia} found on this page)`}
          aria-label={`Download video: ${detectedMedia} found on this page`}
          onClick={() => setPanel('downloads')}
          className="cursor-pointer rounded-md p-1.5 text-[var(--color-accent)] transition hover:bg-white/10"
        >
          <Icon name="video" />
        </button>
      )}
      {shown('performance') && (
        <NavButton
          icon="activity"
          label="Performance (Ctrl+Shift+P)"
          active={panel === 'performance'}
          onClick={() => togglePanel('performance')}
        />
      )}
      <NavButton
        icon="settings"
        label="Settings (Ctrl+,)"
        onClick={() => useBrowserStore.getState().openSettings()}
      />

      {/* The app menu every browser has. Private browsing and the AI panel were
          both built and both reachable only by a shortcut nobody was told
          about, which from the user's side is indistinguishable from missing.
          Never hideable: it is the route to everything else. */}
      <NavButton
        icon="menu"
        label="Main menu"
        onClick={() => void window.browser.invoke('menu:showAppMenu', undefined)}
      />
    </div>
  )
}

function NavButton({
  icon,
  label,
  onClick,
  disabled = false,
  active = false
}: {
  icon: Parameters<typeof Icon>[0]['name']
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={[
        'cursor-pointer rounded-md p-1.5 transition',
        active
          ? 'bg-white/10 text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text-primary)]',
        'disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent'
      ].join(' ')}
    >
      <Icon name={icon} />
    </button>
  )
}
