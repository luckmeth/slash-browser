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
  const [qualities, setQualities] = useState<InvokeResponse<'media:qualities'> | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [switchNote, setSwitchNote] = useState<string | null>(null)
  const [external, setExternal] = useState<InvokeResponse<'media:externalFormats'> | null>(null)
  // Distinct from `external === null`, which also means "never asked". Listing
  // shells out to another program and reads a whole watch page, which took
  // several seconds with nothing on screen to say why — the panel simply looked
  // finished, and the qualities appeared later as if from nowhere.
  const [externalLoading, setExternalLoading] = useState(false)
  const [externalNote, setExternalNote] = useState<string | null>(null)
  const [started, setStarted] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /**
   * Where the file will go.
   *
   * Shown rather than assumed. "Saved to your Downloads folder" was a sentence
   * at the bottom of the dialog that stopped being true the moment somebody
   * changed the setting, and there was no way to choose from here at all.
   */
  const [directory, setDirectory] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | undefined>(undefined)

  const close = (): void => {
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }

  useEffect(() => {
    // Asked for at the same time as the options, because on a site that
    // publishes no addresses the two lists are very different: options is what
    // can be downloaded *now*, qualities is what the player could be asked to
    // fetch. The gap between them is the whole "only 360p" complaint.
    // Asked for in parallel. It shells out to another program, so it is much
    // slower than the rest of this panel and must not hold it up.
    setExternalLoading(true)
    void window.browser
      .invoke('media:externalFormats', undefined)
      .then((result) => {
        if (result.ok) setExternal(result.value)
      })
      .finally(() => setExternalLoading(false))

    void window.browser.invoke('media:qualities', undefined).then((result) => {
      if (result.ok) setQualities(result.value)
    })

    void window.browser.invoke('media:options', undefined).then((result) => {
      if (result.ok) setOptions(result.value)
      else setOptions({ title: '', choices: [], note: 'This page could not be read.' })
    })
    void window.browser.invoke('downloadEngine:destination', undefined).then((result) => {
      if (result.ok) setDirectory(result.value.directory)
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
    void window.browser
      .invoke('media:downloadChoice', {
        url: choice.url,
        ...(chosen === undefined ? {} : { directory: chosen })
      })
      .then((result) => {
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

  const chooseFolder = (): void => {
    void window.browser.invoke('downloadEngine:chooseFolder', undefined).then((result) => {
      // A cancelled dialog is an ordinary outcome, not an error: the folder
      // already shown stays as it was.
      if (!result.ok || result.value.directory === null) return
      setDirectory(result.value.directory)
      setChosen(result.value.directory)
    })
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/45 p-6"
      onClick={close}
    >
      <div
        className="glass-float slash-surface-in flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl p-5"
        onClick={(event) => event.stopPropagation()}
      >
        {/*
          A tinted band rather than a plain row. This panel appears over a
          playing video and had the same weight as a tooltip; the gradient and
          the accent rule give it a top edge, so it reads as something that
          opened rather than something that was always there.
        */}
        <div className="-mx-5 -mt-5 mb-4 flex items-start gap-3 rounded-t-2xl border-b border-[var(--color-accent)]/25 bg-gradient-to-br from-[var(--color-accent)]/18 via-[var(--color-accent)]/8 to-transparent px-5 py-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--color-accent)]/25 text-[var(--color-accent)] shadow-[0_0_0_1px_var(--color-accent)]/20">
            <Icon name="video" size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">
              Download this video
            </h2>
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

        {qualities !== null && qualities.levels.length > 0 && (
          <div className="mt-4 rounded-xl border border-[var(--glass-edge)] bg-white/5 p-3">
            <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              This site publishes no addresses on the page, so Slash can only offer a quality the
              player has actually fetched. Pick one and it will be requested — this changes what is
              playing, and takes a few seconds.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {qualities.levels.map((quality) => (
                <button
                  key={quality.level}
                  type="button"
                  disabled={switching !== null || started !== null}
                  onClick={() => {
                    setSwitching(quality.level)
                    setSwitchNote(null)
                    void window.browser
                      .invoke('media:requestQuality', { level: quality.level })
                      .then((result) => {
                        setSwitching(null)
                        if (!result.ok) return setSwitchNote('That did not work.')
                        setSwitchNote(result.value.note)
                        // Whatever the player fetched is now downloadable.
                        void window.browser
                          .invoke('media:options', undefined)
                          .then((next) => next.ok && setOptions(next.value))
                      })
                  }}
                  className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition disabled:opacity-40 ${
                    quality.current
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/20 text-[var(--color-accent)] shadow-sm'
                      : 'border-white/10 bg-white/[0.04] text-[var(--color-text-primary)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/10'
                  }`}
                >
                  {switching === quality.level ? (
                    <span className="flex items-center gap-1.5">
                      <Spinner />
                      Fetching
                    </span>
                  ) : (
                    quality.label
                  )}
                </button>
              ))}
            </div>
            {switchNote !== null && (
              <p className="mt-2 text-[11px] text-[var(--color-text-muted)]" role="status">
                {switchNote}
              </p>
            )}
          </div>
        )}

        {externalLoading && (
          <div className="mt-4 rounded-xl border border-[var(--glass-edge)] bg-white/5 p-3">
            <p className="flex items-center gap-2 text-[11px] font-medium text-[var(--color-text-primary)]">
              <Spinner />
              Checking for higher qualities…
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              yt-dlp is reading this page. This usually takes a few seconds.
            </p>
            {/* Rows the real list will replace, so the panel does not jump. */}
            <div className="mt-2 space-y-1">
              {[0, 1, 2].map((row) => (
                <div
                  key={row}
                  className="h-8 animate-pulse rounded-lg bg-white/[0.06]"
                  style={{ animationDelay: `${row * 120}ms` }}
                />
              ))}
            </div>
          </div>
        )}

        {!externalLoading && external !== null && (external.choices.length > 0 || external.note !== null) && (
          <div className="mt-4 rounded-xl border border-[var(--glass-edge)] bg-white/5 p-3">
            <p className="flex items-center gap-2 text-[11px] font-medium text-[var(--color-text-primary)]">
              <span className="rounded bg-[var(--color-accent)]/20 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--color-accent)] uppercase">
                yt-dlp
              </span>
              Higher qualities
            </p>
            {external.note !== null && (
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                {external.note}
              </p>
            )}
            {external.choices.length > 0 && (
              <ul className="mt-2 space-y-1">
                {external.choices.map((choice) => (
                  <li key={choice.selector}>
                    <button
                      type="button"
                      disabled={started !== null}
                      onClick={() => {
                        setExternalNote(`Starting ${choice.label}…`)
                        void window.browser
                          .invoke('media:downloadExternal', {
                            selector: choice.selector,
                            label: choice.label
                          })
                          .then((result) => {
                            setExternalNote(result.ok ? result.value.note : 'That did not start.')
                          })
                      }}
                      className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left text-[11.5px] transition hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 disabled:opacity-50"
                    >
                      <span className="truncate">{choice.label}</span>
                      <span className="shrink-0 text-[var(--color-text-muted)]">
                        {choice.sizeText}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {externalNote !== null && (
              <p className="mt-2 text-[11px] text-[var(--color-text-muted)]" role="status">
                {externalNote}
              </p>
            )}
          </div>
        )}

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

        {/* Where it goes, and a way to change it — rather than a sentence
            claiming a folder that may not be the one in the settings. */}
        {options && options.choices.length > 0 && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-2.5 py-2">
            <Icon name="folder" size={13} className="shrink-0 text-[var(--color-text-muted)]" />
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] text-[var(--color-text-muted)]">Save to</span>
              <span className="block truncate text-[11px]" title={directory ?? undefined}>
                {directory ?? 'your Downloads folder'}
              </span>
            </span>
            <button
              type="button"
              onClick={chooseFolder}
              disabled={started !== null}
              className="shrink-0 cursor-pointer rounded border border-[var(--color-border-subtle)] px-2 py-1 text-[10px] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
            >
              Change
            </button>
          </div>
        )}

        {/* Said once, plainly, where the decision is being made. */}
        <p className="mt-3 border-t border-[var(--color-border-subtle)] pt-3 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
          Check that you have the right to keep a copy — some sites allow it and some do not, and
          that is between you and them.
        </p>
      </div>
    </div>
  )
}

/**
 * A small spinner for work that takes seconds rather than milliseconds.
 *
 * `currentColor` so it inherits whatever it sits in — accent on a selected
 * chip, muted in a note — rather than needing a variant per placement.
 */
function Spinner(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
    />
  )
}
