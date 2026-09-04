import { useEffect, useState } from 'react'
import type { ReadingItem } from '@shared/types/readingList'
import { hostOf } from '@shared/url'
import { Icon } from '../../components/Icon'

/**
 * The read-later queue.
 *
 * Distinct from bookmarks by design: a bookmark is a permanent reference, a
 * reading-list entry is something you intend to clear. Read items are kept and
 * struck through rather than deleted, so finishing something is reversible and
 * you can see what you got through.
 */
export function ReadingListPanel(): React.JSX.Element {
  const [items, setItems] = useState<ReadingItem[] | null>(null)

  useEffect(() => {
    void window.browser.invoke('reading:list', undefined).then((result) => {
      if (result.ok) setItems(result.value)
    })
  }, [])

  const unread = items?.filter((item) => item.readAt === null) ?? []
  const read = items?.filter((item) => item.readAt !== null) ?? []

  if (items === null) {
    return <p className="px-4 py-6 text-xs text-[var(--color-text-muted)]">Loading…</p>
  }

  // A real empty state rather than blank space, saying how to fill it.
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 py-10 text-center">
        <Icon name="bookmarks" size={22} className="text-[var(--color-text-muted)]" />
        <p className="mt-3 text-sm">Nothing to read yet</p>
        <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-text-muted)]">
          Save a page with <Key>Ctrl</Key>+<Key>Shift</Key>+<Key>D</Key>, or from the Library menu.
          Unlike a bookmark, it is meant to be cleared once you have read it.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {unread.map((item) => (
        <Row key={item.id} item={item} onChange={setItems} />
      ))}

      {read.length > 0 && (
        <>
          <div className="flex items-center justify-between px-3 pt-3 pb-1">
            <span className="text-[10px] font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
              Read
            </span>
            <button
              type="button"
              onClick={() => {
                void window.browser.invoke('reading:clearRead', undefined).then((result) => {
                  if (result.ok) setItems(result.value)
                })
              }}
              className="cursor-default text-[11px] text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
            >
              Clear
            </button>
          </div>
          {read.map((item) => (
            <Row key={item.id} item={item} onChange={setItems} />
          ))}
        </>
      )}
    </div>
  )
}

function Row({
  item,
  onChange
}: {
  item: ReadingItem
  onChange: (items: ReadingItem[]) => void
}): React.JSX.Element {
  const done = item.readAt !== null

  return (
    <div className="group flex items-center gap-2.5 px-3 py-2 transition hover:bg-white/[0.06]">
      <input
        type="checkbox"
        checked={done}
        aria-label={done ? `Mark ${item.title} unread` : `Mark ${item.title} read`}
        onChange={() => {
          void window.browser
            .invoke('reading:setRead', { id: item.id, read: !done })
            .then((result) => {
              if (result.ok) onChange(result.value)
            })
        }}
        className="shrink-0"
      />

      <button
        type="button"
        title={item.url}
        onClick={() => {
          void window.browser.invoke('tabs:create', { url: item.url, background: false })
        }}
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {item.faviconUrl ? (
            <img
              src={item.faviconUrl}
              alt=""
              className="size-3.5 rounded-sm"
              onError={(event) => {
                event.currentTarget.style.visibility = 'hidden'
              }}
            />
          ) : (
            <Icon name="globe" size={12} className="text-[var(--color-text-muted)]" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[13px] ${done ? 'line-through opacity-55' : ''}`}>
            {item.title || hostOf(item.url)}
          </span>
          <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
            {hostOf(item.url)}
          </span>
        </span>
      </button>

      <button
        type="button"
        aria-label={`Remove ${item.title}`}
        onClick={() => {
          void window.browser.invoke('reading:remove', { id: item.id }).then((result) => {
            if (result.ok) onChange(result.value)
          })
        }}
        className="shrink-0 cursor-default rounded p-1 text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100 hover:bg-white/15 hover:text-[var(--color-text-primary)] focus:opacity-100"
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}

function Key({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-[var(--glass-edge)] bg-white/6 px-1 py-0.5 font-sans text-[10px]">
      {children}
    </kbd>
  )
}
