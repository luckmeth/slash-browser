import { useState } from 'react'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'
import { Favicon, Empty } from './HistoryPanel'

export function BookmarksPanel(): React.JSX.Element {
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draftTitle, setDraftTitle] = useState('')

  const folders = bookmarks.filter((b) => b.isFolder)
  const items = bookmarks.filter((b) => !b.isFolder)

  async function commitRename(id: number): Promise<void> {
    const trimmed = draftTitle.trim()
    if (trimmed) await window.browser.invoke('bookmarks:update', { id, title: trimmed })
    setEditingId(null)
  }

  if (bookmarks.length === 0) {
    return <Empty message="No bookmarks yet. Press Ctrl+D to save the current page." />
  }

  return (
    <ul className="p-2">
      {folders.map((folder) => (
        <li key={folder.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
          <Icon name="folder" size={14} className="text-[var(--color-text-muted)]" />
          <span className="flex-1 truncate">{folder.title}</span>
        </li>
      ))}

      {items.map((bookmark) => (
        <li
          key={bookmark.id}
          className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/5"
        >
          {editingId === bookmark.id ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={() => void commitRename(bookmark.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitRename(bookmark.id)
                if (event.key === 'Escape') setEditingId(null)
              }}
              aria-label="Bookmark title"
              className="flex-1 rounded border border-[var(--color-accent)] bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-sm outline-none"
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  if (activeTabId) {
                    void window.browser.invoke('nav:navigate', {
                      tabId: activeTabId,
                      input: bookmark.url
                    })
                  }
                }}
                onDoubleClick={() => {
                  setEditingId(bookmark.id)
                  setDraftTitle(bookmark.title)
                }}
                title={bookmark.url}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
              >
                <Favicon url={bookmark.faviconUrl} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{bookmark.title}</span>
                  <span className="block truncate text-xs text-[var(--color-text-muted)]">
                    {hostOf(bookmark.url)}
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-label={`Delete bookmark ${bookmark.title}`}
                onClick={() => void window.browser.invoke('bookmarks:delete', { id: bookmark.id })}
                className="shrink-0 cursor-pointer rounded p-1 opacity-0 transition group-hover:opacity-100 hover:bg-white/10"
              >
                <Icon name="trash" size={12} />
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
