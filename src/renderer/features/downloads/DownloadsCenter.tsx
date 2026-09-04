import { useEffect, useMemo, useState } from 'react'
import type { DownloadCategory, EngineDownload } from '@shared/types/downloadEngine'
import { Icon } from '../../components/Icon'

const FILTERS = [
  'all',
  'active',
  'paused',
  'completed',
  'failed',
  'video',
  'audio',
  'document',
  'software',
  'archive'
] as const
type Filter = (typeof FILTERS)[number]

/**
 * The Downloads Center for engine-managed transfers.
 *
 * Shows what is actually happening rather than a bar and a hope: how many
 * connections a file is really using and **why**, the measured rate, and the
 * remaining time only when it can honestly be calculated. A server that hides
 * the file size gets "unknown", not an invented estimate.
 */
export function DownloadsCenter(): React.JSX.Element {
  const [downloads, setDownloads] = useState<EngineDownload[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [batchOpen, setBatchOpen] = useState(false)
  const [pattern, setPattern] = useState('')
  const [preview, setPreview] = useState<{ urls: string[]; note: string; error: boolean } | null>(null)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [refreshUrl, setRefreshUrl] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void window.browser.invoke('downloadEngine:list', undefined).then((result) => {
      if (result.ok) setDownloads(result.value)
    })
    return window.browser.on('downloadEngine:changed', setDownloads)
  }, [])

  const shown = useMemo(() => {
    switch (filter) {
      case 'all':
        return downloads
      case 'active':
        return downloads.filter((d) => ['queued', 'probing', 'downloading'].includes(d.state))
      case 'paused':
        return downloads.filter((d) => d.state === 'paused')
      case 'completed':
        return downloads.filter((d) => d.state === 'completed')
      case 'failed':
        return downloads.filter((d) => d.state === 'failed' || d.state === 'cancelled')
      default:
        return downloads.filter((d) => d.category === (filter as DownloadCategory))
    }
  }, [downloads, filter])

  const call = (
    channel:
      | 'downloadEngine:pause'
      | 'downloadEngine:resume'
      | 'downloadEngine:cancel'
      | 'downloadEngine:remove'
      | 'downloadEngine:startNow',
    id: string
  ): void => {
    void window.browser.invoke(channel, { id })
  }

  /**
   * Move a transfer up or down the queue.
   *
   * The engine has had priorities since Phase 6 and nothing could set one, so a
   * queue of five downloads always ran in the order they were added — which is
   * the one thing a queue is supposed to let you change.
   */
  const setPriority = (id: string, priority: 'high' | 'normal' | 'low'): void => {
    void window.browser.invoke('downloadEngine:setPriority', { id, priority })
  }

  /**
   * Expand the pattern without fetching anything.
   *
   * Deliberately a separate round trip from starting it. A pattern is a rule,
   * and a mistyped rule is five hundred requests to somebody else's server —
   * so the expansion is shown first and the button says how many.
   */
  const previewBatch = (next: string): void => {
    setPattern(next)
    if (next.trim() === '') return setPreview(null)
    void window.browser
      .invoke('downloadEngine:previewBatch', { pattern: next })
      .then((result) => setPreview(result.ok ? result.value : null))
  }

  const startBatch = (): void => {
    void window.browser
      .invoke('downloadEngine:enqueueBatch', { pattern })
      .then((result) => {
        if (result.ok) setNotice(`${result.value.started} queued.`)
        setBatchOpen(false)
        setPattern('')
        setPreview(null)
      })
  }

  const applyRefresh = (id: string): void => {
    void window.browser
      .invoke('downloadEngine:refreshUrl', { id, url: refreshUrl })
      .then((result) => {
        setNotice(result.ok ? result.value.reason : 'That address could not be used.')
        setRefreshing(null)
        setRefreshUrl('')
      })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap gap-1 border-b border-[var(--color-border-subtle)] p-2">
        {FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            className={`cursor-default rounded-md px-2 py-1 text-[11px] capitalize transition ${
              filter === option
                ? 'bg-[var(--color-accent)] text-black'
                : 'text-[var(--color-text-muted)] hover:bg-white/10'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="border-b border-[var(--color-border-subtle)] p-2">
        <button
          type="button"
          onClick={() => setBatchOpen((open) => !open)}
          className="flex w-full cursor-default items-center justify-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Icon name="download" size={12} />
          Batch download…
        </button>

        {batchOpen && (
          <div className="mt-2 space-y-2">
            <input
              value={pattern}
              onChange={(event) => previewBatch(event.target.value)}
              placeholder="https://host/file[1-50].jpg"
              aria-label="Batch download pattern"
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-black/20 px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            <p
              className={`text-[11px] ${
                preview?.error ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'
              }`}
            >
              {preview?.note ??
                'Use [1-50] for numbers or [a-z] for letters. Nothing is fetched until you start.'}
            </p>
            <button
              type="button"
              disabled={!preview || preview.error || preview.urls.length === 0}
              onClick={startBatch}
              className="w-full cursor-default rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs text-black transition disabled:opacity-40"
            >
              {preview && !preview.error ? `Start ${preview.urls.length}` : 'Start'}
            </button>
          </div>
        )}

        {notice !== null && (
          <p className="mt-2 text-[11px] text-[var(--color-text-muted)]" role="status">
            {notice}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {shown.length === 0 ? (
          <p className="p-4 text-sm text-[var(--color-text-muted)]">
            {downloads.length === 0
              ? 'No managed downloads yet. Right-click a link and choose “Download with Slash” to use the segmented engine.'
              : `Nothing in ${filter}.`}
          </p>
        ) : (
          <ul className="space-y-2">
            {shown.map((item) => (
              <li
                key={item.id}
                className="slash-enter rounded-lg border border-[var(--color-border-subtle)] p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{item.filename}</p>
                    <p className="truncate text-[11px] text-[var(--color-text-muted)]">
                      {item.sourceHost} · {item.category}
                      {/* Otherwise "Do first" is a button with no visible effect. */}
                      {item.priority !== 'normal' && ` · ${item.priority} priority`}
                    </p>
                  </div>
                  <StateChip state={item.state} />
                </div>

                {item.state !== 'completed' && (
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
                      style={{
                        width:
                          item.totalBytes && item.totalBytes > 0
                            ? `${Math.min(100, (item.receivedBytes / item.totalBytes) * 100)}%`
                            : '100%',
                        // An unknown total cannot honestly be a percentage, so the
                        // bar is shown as indeterminate rather than guessing.
                        opacity: item.totalBytes ? 1 : 0.4
                      }}
                    />
                  </div>
                )}

                <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
                  {formatBytes(item.receivedBytes)}
                  {item.totalBytes ? ` of ${formatBytes(item.totalBytes)}` : ' (total unknown)'}
                  {item.bytesPerSecond > 0 && ` · ${formatBytes(item.bytesPerSecond)}/s`}
                  {item.secondsRemaining !== null &&
                    item.state === 'downloading' &&
                    ` · ${formatDuration(item.secondsRemaining)} left`}
                </p>

                {/* The connection count and the reason for it. "4 connections"
                    beside a transfer using one would be a plain lie. */}
                <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                  {item.connectionNote}
                </p>

                {item.error && <p className="mt-1 text-[11px] text-[var(--color-bad)]">{item.error}</p>}

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {item.state === 'downloading' && (
                    <Action label="Pause" onClick={() => call('downloadEngine:pause', item.id)} />
                  )}
                  {(item.state === 'paused' || item.state === 'failed') && (
                    <Action
                      label={item.state === 'failed' ? 'Retry' : 'Resume'}
                      onClick={() => call('downloadEngine:resume', item.id)}
                    />
                  )}
                  {['queued', 'probing', 'downloading', 'paused'].includes(item.state) && (
                    <Action label="Cancel" onClick={() => call('downloadEngine:cancel', item.id)} />
                  )}
                  {item.state === 'completed' && (
                    <>
                      {/*
                        The *engine's* channels. These rows are engine downloads
                        with UUID ids; `downloads:openFile` looks them up in
                        Chromium's own map, found nothing, and returned quietly.
                      */}
                      <Action
                        label="Open"
                        onClick={() =>
                          void window.browser.invoke('downloadEngine:openFile', { id: item.id })
                        }
                      />
                      <Action
                        label="Show in folder"
                        onClick={() =>
                          void window.browser.invoke('downloadEngine:showInFolder', { id: item.id })
                        }
                      />
                    </>
                  )}
                  {/*
                    A scheduled download is queued but deliberately held. Without
                    this there was no way to change your mind short of cancelling
                    and starting again.
                  */}
                  {item.startAfter !== null && item.state === 'queued' && (
                    <Action
                      label="Start now"
                      onClick={() => call('downloadEngine:startNow', item.id)}
                    />
                  )}
                  {['queued', 'probing', 'downloading', 'paused'].includes(item.state) && (
                    <>
                      {item.priority !== 'high' && (
                        <Action label="Do first" onClick={() => setPriority(item.id, 'high')} />
                      )}
                      {item.priority !== 'low' && (
                        <Action label="Do last" onClick={() => setPriority(item.id, 'low')} />
                      )}
                    </>
                  )}
                  {/*
                    A media CDN link expires after a few hours, so a transfer
                    paused overnight wakes to a 403 with a perfectly good
                    half-file beside it. Re-adding it would start from zero.
                  */}
                  {(item.state === 'paused' || item.state === 'failed') && (
                    <Action
                      label="New address…"
                      onClick={() => {
                        setRefreshing(refreshing === item.id ? null : item.id)
                        setRefreshUrl(item.url)
                      }}
                    />
                  )}
                  <Action label="Remove" onClick={() => call('downloadEngine:remove', item.id)} />
                </div>

                {refreshing === item.id && (
                  <div className="mt-2 space-y-1">
                    <input
                      value={refreshUrl}
                      onChange={(event) => setRefreshUrl(event.target.value)}
                      aria-label="New download address"
                      className="w-full rounded-md border border-[var(--color-border-subtle)] bg-black/20 px-2 py-1 text-[11px] outline-none focus:border-[var(--color-accent)]"
                    />
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      The part already downloaded is kept only if the new address proves it is the
                      same file.
                    </p>
                    <Action label="Use this address" onClick={() => applyRefresh(item.id)} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {downloads.some((d) => ['completed', 'failed', 'cancelled'].includes(d.state)) && (
        <div className="border-t border-[var(--color-border-subtle)] p-2">
          <button
            type="button"
            onClick={() => void window.browser.invoke('downloadEngine:clearFinished', undefined)}
            className="flex w-full cursor-default items-center justify-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <Icon name="close" size={12} />
            Clear finished
          </button>
        </div>
      )}
    </div>
  )
}

function Action({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
    >
      {label}
    </button>
  )
}

function StateChip({ state }: { state: EngineDownload['state'] }): React.JSX.Element {
  const tone =
    state === 'completed'
      ? 'text-[var(--color-good)]'
      : state === 'failed' || state === 'cancelled'
        ? 'text-[var(--color-bad)]'
        : 'text-[var(--color-text-muted)]'
  return (
    <span
      className={`shrink-0 rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] ${tone}`}
    >
      {state}
    </span>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
