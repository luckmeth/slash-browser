import { useEffect, useState } from 'react'
import type { InvokeResponse } from '@shared/ipc/contracts'
import { Icon } from '../../components/Icon'

type Options = InvokeResponse<'media:options'>
type Choice = Options['choices'][number]

/**
 * The download picker: every format this page can be saved as.
 *
 * Modal, unlike the chip that opens it. By this point the user has asked a
 * question and is choosing an answer, so covering the page is correct and the
 * list needs room the chip does not have.
 *
 * Two things it must be honest about, both stated on the row rather than in a
 * footnote nobody reads:
 *
 *  - **Which options are a finished video.** A high-resolution stream is very
 *    often picture only, and downloading one to discover it has no sound is how
 *    somebody concludes the feature is broken. Those rows say "no sound".
 *  - **Why the list is empty**, when it is. Segmented delivery and encryption
 *    are different limits and the note names the one that applies.
 */
export function MediaPicker(): React.JSX.Element {
  const [options, setOptions] = useState<Options | null>(null)
  const [started, setStarted] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const close = (): void => {
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }

  useEffect(() => {
    void window.browser.invoke('media:options', undefined).then((result) => {
      if (result.ok) setOptions(result.value)
      else setOptions({ title: '', choices: [], note: 'This page could not be read.' })
    })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [])

  const download = (choice: Choice): void => {
    setStarted(choice.url)
    setFailed(null)
    void window.browser.invoke('media:downloadChoice', { url: choice.url }).then((result) => {
      if (!result.ok) {
        setStarted(null)
        setFailed('That download could not be started.')
        return
      }
      if (!result.value.ok) {
        setStarted(null)
        setFailed(result.value.reason)
        return
      }
      // Closing on success rather than lingering: the download is now in the
      // Downloads panel, which is where its progress lives.
      setTimeout(close, 700)
    })
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/45 p-6"
      onClick={close}
    >
      <div
        className="glass-float animate-rise flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent)]/15 text-[var(--color-accent)]">
            <Icon name="video" size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Download this video</h2>
            {options && options.title !== '' && (
              <p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">
                {options.title}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {options === null && (
          <p className="mt-5 text-xs text-[var(--color-text-muted)]">Reading this page…</p>
        )}

        {options && options.choices.length === 0 && (
          <p className="mt-5 rounded-xl border border-[var(--glass-edge)] bg-white/5 p-3 text-xs leading-relaxed text-[var(--color-text-muted)]">
            {options.note ?? 'There is nothing on this page that Slash can download.'}
          </p>
        )}

        {options && options.choices.length > 0 && (
          <>
            <ul className="mt-4 min-h-0 flex-1 space-y-1.5 overflow-y-auto">
              {options.choices.map((choice) => (
                <li key={choice.url}>
                  <button
                    type="button"
                    disabled={started !== null}
                    onClick={() => download(choice)}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-border-subtle)] px-3 py-2.5 text-left transition hover:border-[var(--color-accent)] disabled:opacity-50"
                  >
                    <Icon
                      name={choice.hasVideo ? 'video' : 'volume'}
                      size={15}
                      className="shrink-0 text-[var(--color-text-muted)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{choice.label}</span>
                      <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                        {choice.sizeText}
                        {!choice.complete && ' · one half of a pair'}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--color-accent)]">
                      {started === choice.url ? 'Starting…' : 'Save'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {options.note && (
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                {options.note}
              </p>
            )}
          </>
        )}

        {failed && <p className="mt-3 text-[11px] text-[var(--color-bad)]">{failed}</p>}

        {/* Said once, plainly, where the decision is being made. */}
        <p className="mt-4 border-t border-[var(--color-border-subtle)] pt-3 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
          Saved to your Downloads folder. Check that you have the right to keep a copy — some sites
          allow it and some do not, and that is between you and them.
        </p>
      </div>
    </div>
  )
}
