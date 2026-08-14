import { useEffect, useRef, useState } from 'react'
import { isInternalUrl, NEW_TAB_URL } from '@shared/types/tab'
import { formatUrlForDisplay, isSecureUrl } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

export function Toolbar(): React.JSX.Element {
  const activeTab = useBrowserStore((s) => s.activeTab())
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const panel = useBrowserStore((s) => s.panel)
  const togglePanel = useBrowserStore((s) => s.togglePanel)
  const focusToken = useBrowserStore((s) => s.focusOmniboxToken)

  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const tabId = activeTab?.id ?? null
  const url = activeTab?.url ?? ''
  const isNewTab = url === NEW_TAB_URL

  // While the user is typing, `draft` owns the field. Clearing it on tab switch
  // or navigation is what stops a half-typed address leaking into another tab.
  useEffect(() => setDraft(null), [tabId, url])

  useEffect(() => {
    if (focusToken === 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])

  const displayed = draft ?? (isNewTab ? '' : formatUrlForDisplay(url))
  const bookmarked = bookmarks.some((b) => !b.isFolder && b.url === url)

  async function submit(): Promise<void> {
    if (!tabId || draft === null) return
    await window.browser.invoke('nav:navigate', { tabId, input: draft })
    setDraft(null)
    inputRef.current?.blur()
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

      <div className="relative mx-1 flex flex-1 items-center">
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
          onBlur={() => setDraft(null)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
            if (event.key === 'Escape') {
              setDraft(null)
              inputRef.current?.blur()
            }
          }}
          className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] py-1.5 pr-9 pl-9 text-sm outline-none transition focus:border-[var(--color-accent)] disabled:opacity-50"
        />

        <button
          type="button"
          aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this tab (Ctrl+D)'}
          title={bookmarked ? 'Remove bookmark' : 'Bookmark this tab (Ctrl+D)'}
          disabled={disabled || isInternalUrl(url)}
          onClick={() => void toggleBookmark()}
          className="absolute right-2 cursor-pointer rounded p-1 transition hover:bg-white/10 disabled:cursor-default disabled:opacity-30"
        >
          <Icon
            name="star"
            size={14}
            filled={bookmarked}
            className={bookmarked ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}
          />
        </button>
      </div>

      <NavButton
        icon="star"
        label="Bookmarks (Ctrl+Shift+O)"
        active={panel === 'bookmarks'}
        onClick={() => togglePanel('bookmarks')}
      />
      <NavButton
        icon="clock"
        label="History (Ctrl+H)"
        active={panel === 'history'}
        onClick={() => togglePanel('history')}
      />
      <NavButton
        icon="download"
        label="Downloads (Ctrl+J)"
        active={panel === 'downloads'}
        onClick={() => togglePanel('downloads')}
      />
      <NavButton
        icon="clock"
        label="Performance (Ctrl+Shift+P)"
        active={panel === 'performance'}
        onClick={() => togglePanel('performance')}
      />
      <NavButton
        icon="settings"
        label="Settings (Ctrl+,)"
        active={panel === 'settings'}
        onClick={() => togglePanel('settings')}
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
