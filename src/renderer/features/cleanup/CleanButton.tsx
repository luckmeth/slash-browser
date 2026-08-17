import { useEffect, useState } from 'react'
import type { CleanupMode, CleanupStatus } from '@shared/types/cleanup'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

const MODE_LABEL: Record<CleanupMode, string> = {
  light: 'Light',
  balanced: 'Balanced',
  aggressive: 'Aggressive'
}

/**
 * CLEAN THIS PAGE.
 *
 * A toolbar button with a small popover, because the mode matters and the result
 * has to be reported. The button always says what actually happened — including
 * "nothing to clean", which is the honest answer on a page that had no overlays
 * and is far better than a success message that teaches the user the button lies.
 */
export function CleanButton(): React.JSX.Element | null {
  const [status, setStatus] = useState<CleanupStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const activeTab = useBrowserStore((s) => s.activeTab())

  const refresh = (): void => {
    void window.browser.invoke('cleanup:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  // Re-read when the page changes: a new document is never still cleaned.
  useEffect(refresh, [activeTab?.url])

  const clean = (mode?: CleanupMode): void => {
    setBusy(true)
    void window.browser.invoke('cleanup:apply', mode ? { mode } : {}).then(() => {
      setBusy(false)
      refresh()
    })
  }

  const restore = (): void => {
    setBusy(true)
    void window.browser.invoke('cleanup:restore', undefined).then((result) => {
      setBusy(false)
      if (result.ok) setStatus(result.value)
    })
  }

  const setDisabled = (disabled: boolean): void => {
    void window.browser.invoke('cleanup:setDisabledForHost', { disabled }).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  if (!status || status.host === '') return null

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Clean this page"
        title={status.active ? 'This page has been cleaned' : 'Clean this page'}
        onClick={() => setOpen((current) => !current)}
        className="cursor-default rounded p-1 transition hover:bg-white/10"
      >
        <Icon
          name="sparkle"
          size={14}
          className={
            status.active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'
          }
        />
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-72 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 shadow-2xl">
          <p className="text-sm font-medium">Clean this page</p>
          <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
            Hides interruptions without touching the page itself. Reloading puts everything back.
          </p>

          {status.disabledForHost ? (
            <>
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Cleanup is switched off for {status.host}.
              </p>
              <Row label="Turn it back on for this site" onClick={() => setDisabled(false)} />
            </>
          ) : (
            <>
              <div className="mt-2 flex gap-1.5">
                {(['light', 'balanced', 'aggressive'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={busy}
                    onClick={() => clean(mode)}
                    className={`flex-1 cursor-default rounded-md border px-2 py-1.5 text-[11px] transition disabled:opacity-50 ${
                      status.mode === mode
                        ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                        : 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
                    }`}
                  >
                    {MODE_LABEL[mode]}
                  </button>
                ))}
              </div>

              {status.lastResult && (
                <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                  {status.lastResult.detail}
                </p>
              )}

              {status.active && <Row label="Restore hidden elements" onClick={restore} />}
              <Row
                label={`Never clean ${status.host}`}
                onClick={() => setDisabled(true)}
              />
            </>
          )}

          {/*
            Aggressive mode can take something wanted. Saying so before the click
            is the difference between a tool and a trap.
          */}
          <p className="mt-2 border-t border-[var(--color-border-subtle)] pt-2 text-[11px] text-[var(--color-text-muted)]">
            Aggressive also hides advertising-shaped blocks and anything pinned to the screen. If a
            page breaks, use Restore or reload.
          </p>
        </div>
      )}
    </div>
  )
}

function Row({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1.5 w-full cursor-default rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5 text-left text-[11px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
    >
      {label}
    </button>
  )
}
