import { useState } from 'react'
import type { Tab } from '@shared/types/tab'
import { isInternalUrl } from '@shared/types/tab'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

export function TabStrip(): React.JSX.Element {
  const tabs = useBrowserStore((s) => s.tabs)
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const pinnedCount = tabs.filter((t) => t.isPinned).length

  async function handleDrop(index: number): Promise<void> {
    if (dragId) await window.browser.invoke('tabs:reorder', { tabId: dragId, toIndex: index })
    setDragId(null)
    setDropIndex(null)
  }

  return (
    <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto pt-1.5">
      {tabs.map((tab, index) => (
        <TabItem
          key={tab.id}
          tab={tab}
          index={index}
          isActive={tab.id === activeTabId}
          isDropTarget={dropIndex === index}
          // A pinned tab may only be dropped among pinned tabs. The strip renders
          // them as separate regions, so allowing a cross-boundary drop would
          // silently flip the tab's pinned state.
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
        className="mb-0.5 ml-1 shrink-0 cursor-pointer rounded-md p-1.5 text-[var(--color-text-muted)] transition hover:bg-white/5 hover:text-[var(--color-text-primary)]"
      >
        <Icon name="plus" />
      </button>

      {pinnedCount > 0 && <div className="sr-only">{pinnedCount} pinned tabs</div>}
    </div>
  )
}

function TabItem({
  tab,
  index,
  isActive,
  isDropTarget,
  canAcceptDrop,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop
}: {
  tab: Tab
  index: number
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

  return (
    <div
      draggable
      onDragStart={(event) => {
        // Also published on the dataTransfer so the workspace rail can accept a
        // drop — reordering is in-component state, but a cross-target drag needs
        // the id to travel with the drag itself.
        event.dataTransfer.setData('text/tab-id', tab.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (!canAcceptDrop) return
        // Default behaviour rejects the drop; preventing it is what makes the
        // element a valid target.
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
        // Middle-click closes, as in every other browser.
        if (event.button === 1) void window.browser.invoke('tabs:close', { tabId: tab.id })
      }}
      role="tab"
      aria-selected={isActive}
      tabIndex={0}
      title={internal ? label : tab.url}
      data-index={index}
      className={[
        'group relative flex h-9 shrink-0 cursor-default items-center gap-2 rounded-t-lg border-t border-r border-l px-3 text-sm transition',
        tab.isPinned ? 'w-[52px] justify-center' : 'w-[200px] max-w-[200px] min-w-[52px]',
        isActive
          ? 'border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-text-primary)]'
          : 'border-transparent text-[var(--color-text-muted)] hover:bg-white/5',
        isDropTarget ? 'ring-2 ring-[var(--color-accent)] ring-inset' : ''
      ].join(' ')}
    >
      <TabIcon tab={tab} internal={internal} />

      {!tab.isPinned && <span className="flex-1 truncate">{label}</span>}

      {!tab.isPinned && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={(event) => {
            event.stopPropagation()
            void window.browser.invoke('tabs:close', { tabId: tab.id })
          }}
          className="shrink-0 rounded p-0.5 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 focus:opacity-100"
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  )
}

function TabIcon({ tab, internal }: { tab: Tab; internal: boolean }): React.JSX.Element {
  if (tab.isLoading) {
    return (
      <span
        className="size-4 shrink-0 animate-spin rounded-full border-2 border-[var(--color-text-muted)] border-t-transparent"
        aria-label="Loading"
      />
    )
  }

  if (tab.status === 'crashed') {
    return <Icon name="warning" className="shrink-0 text-[var(--color-bad)]" />
  }

  if (tab.isAudible || tab.isMuted) {
    return (
      <button
        type="button"
        aria-label={tab.isMuted ? 'Unmute tab' : 'Mute tab'}
        onClick={(event) => {
          event.stopPropagation()
          void window.browser.invoke('tabs:setMuted', { tabId: tab.id, muted: !tab.isMuted })
        }}
        className="shrink-0 rounded p-0.5 hover:bg-white/10"
      >
        <Icon name={tab.isMuted ? 'mute' : 'volume'} size={14} />
      </button>
    )
  }

  if (internal) return <Icon name="globe" className="shrink-0 opacity-60" />

  if (tab.faviconUrl) {
    return (
      <img
        src={tab.faviconUrl}
        alt=""
        className="size-4 shrink-0 rounded-sm"
        // A broken favicon must not leave a torn-image glyph in the strip.
        onError={(event) => {
          event.currentTarget.style.visibility = 'hidden'
        }}
      />
    )
  }

  return <Icon name="globe" className="shrink-0 opacity-60" />
}
