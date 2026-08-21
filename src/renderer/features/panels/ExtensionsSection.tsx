import { useEffect, useState } from 'react'
import type { ExtensionsStatus } from '@shared/types/extensions'
import { Icon } from '../../components/Icon'

/**
 * Unpacked extensions.
 *
 * The copy here is the feature as much as the code is. Electron cannot install
 * from the Chrome Web Store and runs only a subset of the extension APIs, so an
 * "Extensions" page that looked like Chrome's would be a promise this browser
 * cannot keep. Instead it says what it is, and every loaded extension is
 * inspected and listed with the capabilities it asked for that will not work.
 *
 * That inspection is the point: an extension that half-works silently is worse
 * than one that refuses, because the user blames their own machine.
 */
export function ExtensionsSection(): React.JSX.Element {
  const [status, setStatus] = useState<ExtensionsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = (): void => {
    void window.browser.invoke('extensions:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  useEffect(load, [])

  return (
    <div>
      {/* Said first, before the button, because it changes whether someone
          should bother clicking it. */}
      <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Slash can load an <strong>unpacked</strong> extension — a folder containing a
        <code className="mx-1 rounded bg-white/8 px-1">manifest.json</code>. It{' '}
        <strong>cannot install from the Chrome Web Store</strong>, and a <code>.crx</code> file will
        not work: Electron has no install flow, and no browser built on it does.
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Only some of the Chrome extension APIs exist here. Anything relying on talking to a desktop
        program (most download managers), or on cancelling network requests (content blockers), will
        not work — Slash has its own download manager and its own shield for those. Each extension
        below lists what it asked for that is missing.
      </p>

      {status && status.extensions.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {status.extensions.map((extension) => (
            <li
              key={extension.id}
              className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-2"
            >
              <div className="flex items-center gap-2">
                <Icon
                  name={extension.error ? 'warning' : 'sparkle'}
                  size={13}
                  className={`shrink-0 ${
                    extension.error ? 'text-[var(--color-bad)]' : 'text-[var(--color-text-muted)]'
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{extension.name}</span>
                  <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                    {extension.version
                      ? `v${extension.version} · Manifest V${extension.manifestVersion}`
                      : extension.path}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${extension.name}`}
                  onClick={() => {
                    void window.browser
                      .invoke('extensions:remove', { id: extension.id })
                      .then((result) => {
                        if (result.ok) setStatus(result.value)
                      })
                  }}
                  className="shrink-0 cursor-default rounded p-1 text-[var(--color-text-muted)] transition hover:bg-white/15 hover:text-[var(--color-text-primary)]"
                >
                  <Icon name="close" size={12} />
                </button>
              </div>

              {extension.error && (
                <p className="mt-1.5 text-[11px] text-[var(--color-bad)]">
                  Did not load: {extension.error}
                </p>
              )}

              {/* The honest part. Listed per capability with its consequence, so
                  it is actionable rather than a vague compatibility warning. */}
              {extension.gaps.length > 0 && (
                <ul className="mt-1.5 flex flex-col gap-1">
                  {extension.gaps.map((gap) => (
                    <li
                      key={gap.capability}
                      className="flex gap-1.5 text-[11px] leading-snug text-[var(--color-text-muted)]"
                    >
                      <Icon
                        name="warning"
                        size={11}
                        className="mt-0.5 shrink-0 text-[var(--color-warn)]"
                      />
                      <span>
                        <code className="rounded bg-white/8 px-1">{gap.capability}</code>{' '}
                        {gap.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {extension.gaps.length === 0 && !extension.error && (
                <p className="mt-1.5 text-[11px] text-[var(--color-good)]">
                  Nothing it asked for is missing here.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-2 text-[11px] text-[var(--color-bad)]">{error}</p>}

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(null)
          void window.browser.invoke('extensions:add', undefined).then((result) => {
            setBusy(false)
            if (result.ok) setError(result.value.error)
            load()
          })
        }}
        className="mt-2.5 cursor-default rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs transition hover:bg-white/10 disabled:opacity-50"
      >
        {busy ? 'Loading…' : 'Load unpacked extension…'}
      </button>

      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Extensions are re-loaded each time Slash starts. They are not sandboxed from the pages they
        run on any more than they are in Chrome, so load folders you trust.
      </p>
    </div>
  )
}
