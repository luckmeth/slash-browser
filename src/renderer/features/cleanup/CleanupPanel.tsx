import { useCallback, useEffect, useState } from 'react'
import type { CleanupMode, CleanupStatus } from '@shared/types/cleanup'
import { CHROME_HEIGHT } from '@shared/constants'

const MODE_LABEL: Record<CleanupMode, string> = {
  light: 'Light',
  balanced: 'Balanced',
  aggressive: 'Aggressive'
}

/**
 * CLEAN THIS PAGE.
 *
 * Rendered in the **overlay view**. It began as a dropdown in the chrome
 * document, which put it underneath the native page view — so the part of it
 * that extended over the page was simply not drawn, and it read as a popover
 * cut off by the window. Exactly the bug the shield panel had, from exactly the
 * same cause.
 *
 * It always says what actually happened, including "nothing to clean", which is
 * the honest answer on a page that had no overlays and far better than a
 * success message that teaches the user the button lies.
 */
export function CleanupPanel(): React.JSX.Element {
  const [status, setStatus] = useState<CleanupStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const close = useCallback((): void => {
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }, [])

  const refresh = useCallback((): void => {
    void window.browser.invoke('cleanup:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
      else close()
    })
  }, [close])

  useEffect(refresh, [refresh])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const clean = (mode: CleanupMode): void => {
    setBusy(true)
    void window.browser.invoke('cleanup:apply', { mode }).then(() => {
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

  return (
    // Backdrop first: the overlay is modal and swallows every click inside its
    // bounds, so an unpainted region must mean "dismiss", never "dead".
    <div className="fixed inset-0" onClick={close}>
      {status && status.host !== '' && (
        <div
          className="glass-float animate-rise absolute right-3 w-72 rounded-xl p-3"
          style={{ top: CHROME_HEIGHT + 6 }}
          onClick={(event) => event.stopPropagation()}
        >
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
                        : 'border-[var(--glass-edge)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
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
              <Row label={`Never clean ${status.host}`} onClick={() => setDisabled(true)} />
            </>
          )}

          {/*
            Aggressive mode can take something wanted. Saying so before the click
            is the difference between a tool and a trap.
          */}
          <p className="mt-2 border-t border-[var(--glass-edge)] pt-2 text-[11px] text-[var(--color-text-muted)]">
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
      className="mt-1.5 w-full cursor-default rounded-md border border-[var(--glass-edge)] px-2 py-1.5 text-left text-[11px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
    >
      {label}
    </button>
  )
}
