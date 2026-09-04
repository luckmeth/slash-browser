import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types/updates'
import type { Settings } from '@shared/types/settings'

/**
 * Updates, in Settings.
 *
 * There are two different capabilities here and the screen keeps them apart,
 * because conflating them is how a security claim gets overstated.
 *
 * **Fetching and verifying** is available when the feed publishes a checksum.
 * Slash downloads the package, hashes it as it arrives, and deletes it unless
 * it matches. That proves the bytes are the ones that were published — it does
 * not prove who published them, since whoever controls the feed controls both.
 *
 * **Installing without a warning** needs a code signature, which this build
 * does not have. Windows will say "unknown publisher" exactly as it did when
 * Slash was first installed. That is stated here rather than discovered.
 *
 * The feed field is empty by default and no default endpoint is baked in — a
 * browser that phones a server on first launch to ask about updates has made an
 * outbound request nobody agreed to. The automatic check does nothing at all
 * until an address is in that box.
 */
export function UpdateSection({
  feedUrl,
  autoCheck,
  autoDownload,
  onFeedChange
}: {
  feedUrl: string
  autoCheck: boolean
  autoDownload: boolean
  onFeedChange: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [draft, setDraft] = useState(feedUrl)
  const [installing, setInstalling] = useState(false)
  const [installProblem, setInstallProblem] = useState('')

  useEffect(() => {
    void window.browser.invoke('updates:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
    // A download reports progress from main; without this the panel would have
    // to poll, and a progress bar that updates every second by polling is a
    // cost paid on a path that is idle almost always.
    return window.browser.on('updates:changed', (next) => setStatus(next))
  }, [])

  const check = (): void => {
    void window.browser.invoke('updates:check', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--color-text-muted)]">
        Version{' '}
        <span className="text-[var(--color-text-primary)]">
          {status?.currentVersion ?? '—'}
        </span>
        {status?.state === 'update-available' && status.latestVersion && (
          <>
            {' · '}
            <span className="text-[var(--color-accent)]">{status.latestVersion} available</span>
          </>
        )}
      </p>

      {status && <p className="text-[11px] text-[var(--color-text-muted)]">{status.detail}</p>}
      {status?.notes && status.state !== 'up-to-date' && (
        <p className="text-[11px] whitespace-pre-line text-[var(--color-text-muted)]">
          {status.notes}
        </p>
      )}
      {status?.state === 'downloading' && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
            style={{ width: `${Math.max(status.progress * 100, 2)}%` }}
          />
        </div>
      )}
      {installProblem !== '' && (
        <p role="status" aria-live="polite" className="text-[11px] text-[var(--color-warn)]">
          {installProblem}
        </p>
      )}

      <label className="block">
        <span className="mb-1 block text-[11px] text-[var(--color-text-muted)]">
          Release feed URL (empty = never check)
        </span>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== feedUrl) onFeedChange({ updateFeedUrl: draft.trim() })
          }}
          placeholder="https://example.com/updates/latest.yml"
          spellCheck={false}
          className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={draft.trim() === '' || status?.state === 'checking'}
          onClick={check}
          className="cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
        >
          {status?.state === 'checking' ? 'Checking…' : 'Check now'}
        </button>
        {/*
          Only offered once the running binary carries a valid signature. The
          install path is written and wired; `canInstall` is what stands between
          it and being live, and it flips on its own the day the build is signed.
          Showing a disabled button rather than hiding it is deliberate: the
          reason is stated in `status.detail` beside it.
        */}
        {/* Fetch and verify, without installing. Two clicks for two decisions:
            one spends bandwidth, the other closes the browser. */}
        {status?.state === 'update-available' && status.canFetch && !status.canInstall && (
          <button
            type="button"
            disabled={installing}
            title="Download the package and check it against the checksum the feed publishes"
            onClick={() => {
              setInstalling(true)
              setInstallProblem('')
              void window.browser.invoke('updates:download', undefined).then((result) => {
                setInstalling(false)
                if (result.ok && !result.value.ok) setInstallProblem(result.value.detail)
              })
            }}
            className="cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            {installing ? 'Downloading…' : 'Download and verify'}
          </button>
        )}

        {(status?.state === 'update-available' || status?.state === 'ready') && (
          <button
            type="button"
            disabled={(!status.canInstall && !status.canFetch) || installing}
            title={
              status.canInstall
                ? 'Download and install, then restart'
                : status.canFetch
                  ? 'Verifies the package against its published checksum, then starts the installer. Windows will warn about an unknown publisher.'
                  : 'This release publishes no package Slash can verify. Open the release page instead.'
            }
            onClick={() => {
              setInstalling(true)
              void window.browser.invoke('updates:install', undefined).then((result) => {
                setInstalling(false)
                if (result.ok && !result.value.ok) setInstallProblem(result.value.detail)
              })
            }}
            className="cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            {installing
              ? 'Working…'
              : status.state === 'ready'
                ? 'Run the installer'
                : status.canInstall
                  ? 'Install and restart'
                  : 'Download and install'}
          </button>
        )}
        {status?.releaseUrl && (
          <button
            type="button"
            onClick={() =>
              void window.browser.invoke('tabs:create', {
                url: status.releaseUrl!,
                background: false
              })
            }
            className="cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Open the release page
          </button>
        )}
      </div>

      {/*
        The honest bottom line, stated where the user is looking at updates
        rather than buried in a document they will never open.
      */}
      <label className="flex cursor-default items-start gap-2 text-[11px] text-[var(--color-text-muted)]">
        <input
          type="checkbox"
          checked={autoCheck}
          onChange={(event) => onFeedChange({ updateAutoCheck: event.target.checked })}
          className="mt-0.5"
        />
        <span>
          Check on launch and every six hours. Does nothing while the box above is empty — the
          address is what decides whether Slash talks to a server at all.
        </span>
      </label>

      <label className="flex cursor-default items-start gap-2 text-[11px] text-[var(--color-text-muted)]">
        <input
          type="checkbox"
          checked={autoDownload}
          onChange={(event) => onFeedChange({ updateAutoDownload: event.target.checked })}
          className="mt-0.5"
        />
        <span>
          Download the package as soon as one is found. Installing still always asks — this only
          decides whether the bytes are already here when you say yes.
        </span>
      </label>

      <p className="text-[11px] text-[var(--color-text-muted)]">
        What Slash can prove about an update is that it matches the checksum the feed published —
        the bytes are the ones that were released, and no proxy substituted others. What it cannot
        prove is who published them, because this build is not code-signed: Windows will warn about
        an unknown publisher, exactly as it did when you first installed Slash. Chromium ships
        security fixes roughly monthly, so it is worth keeping this on.
      </p>
    </div>
  )
}
