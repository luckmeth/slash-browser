import { useCallback, useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types/updates'
import { BrandMark } from '../../components/BrandMark'

/**
 * The update, asked once per launch, with two answers.
 *
 * The chip in the toolbar remains and is still the polite path. This is the
 * impolite one, and it exists because a chip is precisely as easy to ignore as
 * it is to show — a browser here advertised 0.2.1 in the toolbar for hours
 * while being, underneath, unable to check for updates at all.
 *
 * Two rules it must not break:
 *
 *  - **Cancel always works, and always closes.** Whatever the network is
 *    doing, whatever the feed said, whatever failed. A dialog that can trap
 *    somebody out of their own browser is worse than every advert it was ever
 *    going to save them from. That is why Cancel is a plain close with no
 *    request behind it, and why it is not disabled while busy.
 *  - **Nothing installs without the second click.** Update fetches and
 *    verifies against the published checksum, then hands over the installer,
 *    which asks again. This build is not code-signed, so Windows will warn
 *    about the publisher — said here, before the click, rather than appearing
 *    as a fright at the end.
 */
export function UpdateRequired(): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    void window.browser.invoke('updates:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
    return window.browser.on('updates:changed', (next) => setStatus(next))
  }, [])

  const close = useCallback((): void => {
    // No request behind it on purpose: cancelling must not be able to fail.
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }, [])

  const install = useCallback((): void => {
    setBusy(true)
    setFailed(null)
    // Download first when the bytes are not here yet. `updates:install`
    // refuses rather than fetching silently, because they are two decisions.
    const ready = status?.state === 'ready'
    const step = ready
      ? window.browser.invoke('updates:install', undefined)
      : window.browser
          .invoke('updates:download', undefined)
          .then(() => window.browser.invoke('updates:install', undefined))

    void step
      .then((result) => {
        if (result.ok && result.value.ok) {
          // The installer is running and will ask the browser to close. The
          // dialog goes now so it is not the last thing left on screen.
          close()
          return
        }
        const detail =
          result.ok && !result.value.ok ? result.value.detail : 'The update could not be started.'
        setFailed(detail)
        setBusy(false)
      })
      .catch(() => {
        setFailed('The update could not be started.')
        setBusy(false)
      })
  }, [status, close])

  if (!status) return null

  const version = status.latestVersion ?? 'a newer version'
  const downloading = status.state === 'downloading'
  const percent = typeof status.progress === 'number' ? Math.round(status.progress * 100) : null

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60 p-6">
      <div className="glass-float animate-rise w-full max-w-md rounded-2xl p-7">
        <BrandMark size={36} className="text-[var(--color-text-primary)]" />

        <h1 className="mt-4 text-xl font-semibold tracking-tight">Slash {version} is available</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
          You are running {status.currentVersion}. Slash checks the download against the checksum
          the release publishes before it runs anything, so the bytes are the ones that were
          released.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
          This build is not code-signed, so Windows will warn about an unknown publisher — exactly
          as it did when you first installed Slash.
        </p>

        {downloading && (
          <p className="mt-4 text-sm text-[var(--color-text-muted)]" role="status">
            Downloading{percent === null ? '' : ` — ${percent}%`}
          </p>
        )}

        {failed && (
          <p className="mt-4 text-sm text-[var(--color-danger,#f87171)]" role="alert">
            {failed}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          {/*
            Cancel is never disabled. Whatever the network is doing, this button
            closes the dialog — a modal somebody cannot dismiss is a browser
            they cannot use.
          */}
          <button
            type="button"
            onClick={close}
            className="rounded-lg px-4 py-2 text-sm text-[var(--color-text-muted)] hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={install}
            disabled={busy}
            autoFocus
            className="rounded-lg bg-[var(--color-accent,#4f8cff)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Working…' : 'Update'}
          </button>
        </div>

        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          Cancelling asks again next time you open Slash.
        </p>
      </div>
    </div>
  )
}
