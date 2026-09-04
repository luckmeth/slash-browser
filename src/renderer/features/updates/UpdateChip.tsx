import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types/updates'
import { Icon } from '../../components/Icon'

/**
 * The update, where a browser puts it.
 *
 * Chrome turns its menu button green and Firefox drops a badge in the toolbar,
 * and both do it for the same reason: an update nobody notices is an update
 * nobody installs, and the browser that goes uninstalled is the one carrying
 * last month's Chromium security fixes.
 *
 * It is invisible until there is genuinely something to say — no update, no
 * chip, no space taken — and it says which of the three states it is in rather
 * than one word that could mean any of them:
 *
 *  - **found**: a newer version exists and the package has not been fetched.
 *  - **downloading**: with a percentage, because a 180 MB download that gives
 *    no sign of progress reads as a hang.
 *  - **ready**: verified against the checksum the feed published, one click
 *    from installing.
 *
 * Clicking never installs by surprise. In the ready state it opens the
 * installer, which then asks — Windows will warn about the publisher, because
 * this build is not code-signed, and that is stated in Settings rather than
 * being a shock at the end.
 */
export function UpdateChip(): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  /** What main said when it refused, so a dead click is never silent. */
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    void window.browser.invoke('updates:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
    return window.browser.on('updates:changed', (next) => setStatus(next))
  }, [])

  if (!status) return null

  const showing =
    status.state === 'ready' ||
    status.state === 'downloading' ||
    (status.state === 'update-available' && (status.canFetch || status.canInstall))
  if (!showing) return null

  const ready = status.state === 'ready'
  const downloading = status.state === 'downloading'

  const label = failed
    ? 'Update failed'
    : ready
    ? 'Restart to update'
    : downloading
      ? `Updating ${Math.round(status.progress * 100)}%`
      : `Update to ${status.latestVersion ?? 'the new version'}`

  const act = (): void => {
    if (downloading || busy) return
    setBusy(true)
    setFailed(null)
    const channel = ready || status.canInstall ? 'updates:install' : 'updates:download'
    // The result used to be discarded by a bare `.finally`, so a refusal from
    // main was invisible: the button did nothing, said nothing, and left the
    // chip reading "Restart to update" for ever. Whatever comes back, it is
    // shown -- a click that cannot work must at least say why.
    void window.browser
      .invoke(channel, undefined)
      .then((result) => {
        if (result.ok && !result.value.ok) setFailed(result.value.detail)
        else if (!result.ok) setFailed('The update could not be started.')
      })
      .catch(() => setFailed('The update could not be started.'))
      .finally(() => setBusy(false))
  }

  return (
    <button
      type="button"
      onClick={act}
      disabled={downloading}
      title={failed ?? status.detail}
      aria-label={label}
      className={`app-no-drag flex shrink-0 cursor-default items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition ${
        ready
          ? 'bg-[var(--color-good)]/15 text-[var(--color-good)] hover:bg-[var(--color-good)]/25'
          : 'bg-white/[0.06] text-[var(--color-text-muted)] hover:bg-white/12'
      }`}
    >
      <Icon name={ready ? 'reload' : 'download'} size={13} />
      {label}
    </button>
  )
}
