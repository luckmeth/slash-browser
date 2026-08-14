import type { DownloadItem } from '@shared/types/browsing'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'
import { Empty } from './HistoryPanel'

export function DownloadsPanel(): React.JSX.Element {
  const downloads = useBrowserStore((s) => s.downloads)

  if (downloads.length === 0) return <Empty message="No downloads yet." />

  return (
    <div>
      <div className="flex justify-end border-b border-[var(--color-border-subtle)] px-3 py-2">
        <button
          type="button"
          onClick={() => void window.browser.invoke('downloads:clearCompleted', undefined)}
          className="cursor-pointer text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
        >
          Clear finished
        </button>
      </div>
      <ul className="p-2">
        {downloads.map((item) => (
          <DownloadRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  )
}

function DownloadRow({ item }: { item: DownloadItem }): React.JSX.Element {
  const active = item.state === 'progressing' || item.state === 'paused'
  // A server that sends no Content-Length gives totalBytes -1; showing a
  // percentage then would be a fabricated number, so the bar goes indeterminate.
  const knownSize = item.totalBytes > 0
  const percent = knownSize ? Math.min(100, (item.receivedBytes / item.totalBytes) * 100) : null

  return (
    <li className="rounded-md px-2 py-2 hover:bg-white/5">
      <div className="flex items-start gap-2">
        <Icon
          name={item.isDangerous ? 'warning' : 'download'}
          size={14}
          className={`mt-0.5 shrink-0 ${item.isDangerous ? 'text-[var(--color-bad)]' : 'text-[var(--color-text-muted)]'}`}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm" title={item.filename}>
            {item.filename}
          </p>
          <p className="truncate text-xs text-[var(--color-text-muted)]">
            {hostOf(item.url)} · {describe(item)}
          </p>

          {active && (
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full bg-[var(--color-accent)] ${percent === null ? 'w-1/3 animate-pulse' : ''}`}
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            </div>
          )}

          <div className="mt-1.5 flex gap-2 text-xs">
            {active && item.state === 'progressing' && (
              <Action label="Pause" onClick={() => void window.browser.invoke('downloads:pause', { id: item.id })} />
            )}
            {item.state === 'paused' && (
              <Action label="Resume" onClick={() => void window.browser.invoke('downloads:resume', { id: item.id })} />
            )}
            {active && (
              <Action label="Cancel" onClick={() => void window.browser.invoke('downloads:cancel', { id: item.id })} />
            )}
            {item.state === 'completed' && (
              <>
                <Action label="Open" onClick={() => void window.browser.invoke('downloads:openFile', { id: item.id })} />
                <Action
                  label="Show in folder"
                  onClick={() => void window.browser.invoke('downloads:showInFolder', { id: item.id })}
                />
              </>
            )}
            <Action
              label="Remove"
              onClick={() => void window.browser.invoke('downloads:remove', { id: item.id })}
            />
          </div>
        </div>
      </div>
    </li>
  )
}

function Action({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer text-[var(--color-text-muted)] transition hover:text-[var(--color-accent)]"
    >
      {label}
    </button>
  )
}

function describe(item: DownloadItem): string {
  const received = formatBytes(item.receivedBytes)
  switch (item.state) {
    case 'completed':
      return formatBytes(item.receivedBytes)
    case 'cancelled':
      return 'Cancelled'
    case 'interrupted':
      return 'Interrupted — cannot be resumed'
    case 'paused':
      return `Paused · ${received}`
    default:
      return item.totalBytes > 0 ? `${received} of ${formatBytes(item.totalBytes)}` : received
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 0) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
