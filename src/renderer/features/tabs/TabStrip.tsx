import { useState } from 'react'
import type { Tab } from '@shared/types/tab'
import { isInternalUrl } from '@shared/types/tab'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

const MAX_TAB_WIDTH = 220
const MIN_TAB_WIDTH = 44
const PINNED_TAB_WIDTH = 42

/**
 * The tab strip, which doubles as the window's title bar.
 *
 * Two consequences of living in the title bar:
 *  - every interactive element needs `app-no-drag`, or the window-drag handler
 *    swallows the click before it arrives
 *  - tabs shrink to fit rather than scrolling, the way Chrome and Edge do. A
 *    horizontally scrolling strip is a desktop-app pattern; browsers compress.
 */
export function TabStrip(): React.JSX.Element {
  const tabs = useBrowserStore((s) => s.tabs)
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [stripWidth, setStripWidth] = useState(0)

  const pinnedCount = tabs.filter((t) => t.isPinned).length
  const flexibleCount = tabs.length - pinnedCount
  // Leave room for the new-tab button.
  const available = Math.max(0, stripWidth - pinnedCount * (PINNED_TAB_WIDTH + 2) - 40)
  const tabWidth =
    flexibleCount === 0
      ? MAX_TAB_WIDTH
      : Math.max(MIN_TAB_WIDTH, Math.min(MAX_TAB_WIDTH, Math.floor(available / flexibleCount) - 2))

  async function handleDrop(index: number): Promise<void> {
    if (dragId) await window.browser.invoke('tabs:reorder', { tabId: dragId, toIndex: index })
    setDragId(null)
    setDropIndex(null)
  }

  return (
    <div
      ref={(node) => {
        if (node) setStripWidth(node.clientWidth)
      }}
      className="flex min-w-0 flex-1 items-end gap-0.5 overflow-hidden px-2 pt-1.5"
      role="tablist"
      aria-label="Tabs"
    >
      {tabs.map((tab, index) => (
        <TabItem
          key={tab.id}
          tab={tab}
          width={tab.isPinned ? PINNED_TAB_WIDTH : tabWidth}
          isActive={tab.id === activeTabId}
          isDropTarget={dropIndex === index}
          canAcceptDrop={
            dragId !== null &&
            (tabs.find((t) => t.id === dragId)?.isPinned ?? false) === tab.isPinned
          }
          onDragStart={() => setDragId(tab.id)}
          onDragEnd={() => {
            setDragId(null)
            setDropIndex(null)
          }}
          onDragOver={() => setDropIndex(index)}
          onDrop={() => void handleDrop(index)}
        />
      ))}

      <button
        type="button"
        title="New tab (Ctrl+T)"
        aria-label="New tab"
        onClick={() => void window.browser.invoke('tabs:create', { background: false })}
        className="app-no-drag mb-1 shrink-0 cursor-default rounded-md p-1.5 text-[var(--color-text-muted)] transition hover:bg-white/10 hover:text-[var(--color-text-primary)]"
      >
        <Icon name="plus" size={15} />
      </button>
    </div>
  )
}

function TabItem({
  tab,
  width,
  isActive,
  isDropTarget,
  canAcceptDrop,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop
}: {
  tab: Tab
  width: number
  isActive: boolean
  isDropTarget: boolean
  canAcceptDrop: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: () => void
  onDrop: () => void
}): React.JSX.Element {
  const internal = isInternalUrl(tab.url)
  const label = tab.title || (internal ? 'New tab' : hostOf(tab.url)) || 'Untitled'
  // Below this the label is unreadable anyway, so show icon only — the same
  // thing Chrome does as tabs compress.
  const compact = width < 90

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/tab-id', tab.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (!canAcceptDrop) return
        event.preventDefault()
        onDragOver()
      }}
      onDrop={(event) => {
        if (!canAcceptDrop) return
        event.preventDefault()
        onDrop()
      }}
      onClick={() => void window.browser.invoke('tabs:activate', { tabId: tab.id })}
      onAuxClick={(event) => {
        if (event.button === 1) void window.browser.invoke('tabs:close', { tabId: tab.id })
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        void window.browser.invoke('menu:showTabContextMenu', { tabId: tab.id })
      }}
      role="tab"
      aria-selected={isActive}
      tabIndex={0}
      title={internal ? label : `${label}\n${tab.url}`}
      style={{ width }}
      className={[
        'app-no-drag group relative flex h-[31px] shrink-0 cursor-default items-center gap-2 rounded-t-lg px-2.5 text-[13px] transition-colors',
        compact ? 'justify-center' : '',
        isActive
          ? 'bg-[var(--color-surface-raised)] text-[var(--color-text-primary)] shadow-[0_-1px_0_var(--color-border-subtle),1px_0_0_var(--color-border-subtle),-1px_0_0_var(--color-border-subtle)]'
          : 'text-[var(--color-text-muted)] hover:bg-white/[0.06]',
        isDropTarget ? 'ring-2 ring-[var(--color-accent)] ring-inset' : ''
      ].join(' ')}
    >
      <TabIcon tab={tab} internal={internal} />

      {!compact && <span className="flex-1 truncate">{label}</span>}

      {!compact && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={(event) => {
            event.stopPropagation()
            void window.browser.invoke('tabs:close', { tabId: tab.id })
          }}
          className="app-no-drag shrink-0 rounded p-0.5 opacity-0 transition group-hover:opacity-100 hover:bg-white/15 focus:opacity-100"
        >
          <Icon name="close" size={11} />
        </button>
      )}
    </div>
  )
}

function TabIcon({ tab, internal }: { tab: Tab; internal: boolean }): React.JSX.Element {
  if (tab.isLoading) {
    return (
      <span
        className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--color-text-muted)] border-t-transparent"
        aria-label="Loading"
      />
    )
  }

  if (tab.status === 'crashed') {
    return <Icon name="warning" size={14} className="shrink-0 text-[var(--color-bad)]" />
  }

  // A sleeping tab is dimmed rather than badged: it is still a normal tab, and a
  // loud indicator would imply something went wrong.
  const dimmed = tab.status === 'hibernated' ? 'opacity-40' : ''

  if (tab.isAudible || tab.isMuted) {
    return (
      <button
        type="button"
        aria-label={tab.isMuted ? 'Unmute tab' : 'Mute tab'}
        onClick={(event) => {
          event.stopPropagation()
          void window.browser.invoke('tabs:setMuted', { tabId: tab.id, muted: !tab.isMuted })
        }}
        className="app-no-drag shrink-0 rounded p-0.5 hover:bg-white/15"
      >
        <Icon name={tab.isMuted ? 'mute' : 'volume'} size={13} />
      </button>
    )
  }

  if (internal) return <Icon name="globe" size={14} className={`shrink-0 opacity-60 ${dimmed}`} />

  if (tab.faviconUrl) {
    return (
      <img
        src={tab.faviconUrl}
        alt=""
        className={`size-4 shrink-0 rounded-sm ${dimmed}`}
        onError={(event) => {
          event.currentTarget.style.visibility = 'hidden'
        }}
      />
    )
  }

  return <Icon name="globe" size={14} className={`shrink-0 opacity-60 ${dimmed}`} />
}
