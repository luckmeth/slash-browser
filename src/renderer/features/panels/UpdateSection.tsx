import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types/updates'
import type { Settings } from '@shared/types/settings'

/**
 * Update checking, in Settings.
 *
 * States the constraint rather than hiding it: this build can *find* a newer
 * version but cannot install one, because it is not code-signed and therefore
 * cannot verify a package came from us. Offering an Install button that refused
 * would be worse than not offering one.
 *
 * The feed field is empty by default and no default endpoint is baked in — a
 * browser that phones a server on first launch to ask about updates has made an
 * outbound request nobody agreed to.
 */
export function UpdateSection({
  feedUrl,
  onFeedChange
}: {
  feedUrl: string
  onFeedChange: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [draft, setDraft] = useState(feedUrl)

  useEffect(() => {
    void window.browser.invoke('updates:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
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
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Slash cannot install updates for itself: this build is not code-signed, so it has no way to
        confirm an update package came from us. Chromium ships security fixes roughly monthly, so
        check periodically and install manually.
      </p>
    </div>
  )
}
