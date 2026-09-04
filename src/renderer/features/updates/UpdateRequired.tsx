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
 * Three rules it must not break:
 *
 *  - **Cancel always works, and always closes.** Whatever the network is
 *    doing, whatever the feed said, whatever failed. A dialog that can trap
 *    somebody out of their own browser is worse than every advert it was ever
 *    going to save them from. So Cancel is a plain close with no request
 *    behind it, and it is never disabled.
 *  - **Update is never a click that cannot work.** Pressing it mid-download
 *    used to call `updates:download` a second time and fail, which showed the
 *    user an error for doing exactly what the dialog invited. It now *arms*
 *    instead: the download finishes and the install starts on its own.
 *  - **Nothing installs without that click.** The bytes are checked against
 *    the published checksum first, and this build is not code-signed, which is
 *    said here rather than discovered at the end.
 */
export function UpdateRequired(): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState(false)
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

  const runInstall = useCallback((): void => {
    setBusy(true)
    setFailed(null)
    void window.browser
      .invoke('updates:install', undefined)
      .then((result) => {
        if (result.ok && result.value.ok) return
        const detail =
          result.ok && !result.value.ok ? result.value.detail : 'The update could not be started.'
        setFailed(detail)
        setBusy(false)
        setArmed(false)
      })
      .catch(() => {
        setFailed('The update could not be started.')
        setBusy(false)
        setArmed(false)
      })
  }, [])

  const state = status?.state
  const downloading = state === 'downloading'
  const ready = state === 'ready'

  // Armed and the bytes have landed: install without a second click. This is
  // what makes pressing Update mid-download do the obvious thing instead of
  // returning an error about a download that was already running.
  useEffect(() => {
    if (armed && ready && !busy) runInstall()
  }, [armed, ready, busy, runInstall])

  const act = useCallback((): void => {
    if (busy) return
    setFailed(null)
    if (ready) {
      runInstall()
      return
    }
    // Not downloaded yet. Arm, and start the fetch if nothing is fetching.
    setArmed(true)
    if (!downloading) {
      void window.browser.invoke('updates:download', undefined).then((result) => {
        if (result.ok && !result.value.ok) {
          setFailed(result.value.detail)
          setArmed(false)
        }
      })
    }
  }, [busy, ready, downloading, runInstall])

  if (!status) return null

  const version = status.latestVersion ?? 'a newer version'
  const percent = downloading ? Math.round((status.progress ?? 0) * 100) : null

  const label = busy ? 'Installing…' : armed && downloading ? 'Installing when ready' : 'Update'

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

        {(downloading || busy) && (
          <div className="mt-5">
            <div className="flex items-baseline justify-between text-xs text-[var(--color-text-muted)]">
              <span role="status">
                {busy ? 'Installing — Slash will close and reopen' : 'Downloading the update'}
              </span>
              {percent !== null && !busy && <span>{percent}%</span>}
            </div>
            {/*
              A bar rather than a number alone: a 176 MB download that reports
              only a percentage in prose reads as a stalled dialog. Width is a
              transition so it moves rather than jumping between samples, and
              an indeterminate stripe covers the install, which has no progress
              to report because NSIS owns it by then.
            */}
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full bg-[var(--color-accent,#4f8cff)] transition-[width] duration-500 ease-out ${
                  busy ? 'w-full animate-pulse' : ''
                }`}
                style={busy ? undefined : { width: `${percent ?? 0}%` }}
              />
            </div>
          </div>
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
            onClick={act}
            disabled={busy || (armed && downloading)}
            autoFocus
            className="rounded-lg bg-[var(--color-accent,#4f8cff)] px-4 py-2 text-sm font-medium text-white transition disabled:opacity-60"
          >
            {label}
          </button>
        </div>

        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          Cancelling asks again next time you open Slash.
        </p>
      </div>
    </div>
  )
}
