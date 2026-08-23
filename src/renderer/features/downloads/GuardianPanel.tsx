import { useEffect, useState } from 'react'
import type { DownloadScan, LinkVerdict, MediaScan } from '@shared/types/downloadGuardian'
import { Icon } from '../../components/Icon'
import { useBrowserStore } from '../../stores/browserStore'

const VERDICT_LABEL: Record<LinkVerdict, string> = {
  'likely-official': 'Likely official',
  'third-party': 'Third-party',
  advertisement: 'Advertisement',
  suspicious: 'Potentially suspicious'
}

const VERDICT_TONE: Record<LinkVerdict, string> = {
  'likely-official': 'text-[var(--color-good)] border-[var(--color-good)]',
  'third-party': 'text-[var(--color-text-muted)] border-[var(--color-border-subtle)]',
  advertisement: 'text-[var(--color-bad)] border-[var(--color-bad)]',
  suspicious: 'text-[var(--color-bad)] border-[var(--color-bad)]'
}

/**
 * Smart Download Guardian, and media detection.
 *
 * Scanned on request rather than continuously — the answer is only interesting
 * at the moment you are about to click something, and walking every anchor of
 * every page to keep a panel warm would be a permanent cost for a rare question.
 *
 * The wording throughout is hedged on purpose. This panel can say a link looks
 * like it belongs to the site and can say a link sits in an ad slot; it cannot
 * say a file is safe, and it never does.
 */
export function GuardianPanel(): React.JSX.Element {
  const [scan, setScan] = useState<DownloadScan | null>(null)
  const [media, setMedia] = useState<MediaScan | null>(null)
  const [busy, setBusy] = useState<'links' | 'media' | null>(null)
  const detectedMedia = useBrowserStore((s) => s.detectedMedia)

  const scanLinks = (): void => {
    setBusy('links')
    void window.browser.invoke('guardian:scanDownloads', undefined).then((result) => {
      setBusy(null)
      if (result.ok) setScan(result.value)
    })
  }

  const scanMedia = (): void => {
    setBusy('media')
    void window.browser.invoke('guardian:scanMedia', undefined).then((result) => {
      setBusy(null)
      if (result.ok) setMedia(result.value)
    })
  }

  // The toolbar's video button opens this panel, and arriving at an empty
  // panel with a button to press is the feature not working. Only when
  // something was actually detected — a scan on every open would inject a
  // script into every page somebody looks at their downloads on.
  useEffect(() => {
    if (detectedMedia === 0) return
    setBusy('media')
    void window.browser.invoke('guardian:scanMedia', undefined).then((result) => {
      setBusy(null)
      if (result.ok) setMedia(result.value)
    })
  }, [detectedMedia])

  const download = (url: string): void => {
    void window.browser.invoke('downloadEngine:enqueue', {
      url,
      priority: 'normal',
      startAfter: null
    })
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={scanLinks}
          className="flex-1 cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
        >
          {busy === 'links' ? 'Scanning…' : 'Check download links'}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={scanMedia}
          className="flex-1 cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
        >
          {busy === 'media' ? 'Scanning…' : 'Find media'}
        </button>
      </div>

      {scan && (
        <section>
          {scan.note && (
            <p className="mb-2 text-xs text-[var(--color-text-muted)]">{scan.note}</p>
          )}
          <ul className="space-y-2">
            {scan.candidates.map((candidate) => (
              <li
                key={candidate.url}
                className="rounded-lg border border-[var(--color-border-subtle)] p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm">{candidate.label}</p>
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${VERDICT_TONE[candidate.verdict]}`}
                  >
                    {VERDICT_LABEL[candidate.verdict]}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
                  {candidate.host}
                </p>

                {/* Every signal, not a score. "The text says Download but it
                    points at another site" is something a person can act on. */}
                <ul className="mt-1.5 space-y-0.5">
                  {candidate.reasons.map((reason, index) => (
                    <li key={index} className="text-[11px] text-[var(--color-text-muted)]">
                      · {reason}
                    </li>
                  ))}
                </ul>

                <div className="mt-2 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => download(candidate.url)}
                    className="cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  >
                    Download this
                  </button>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(candidate.url)}
                    className="cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  >
                    Copy address
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
            Based on detected signals only. Slash cannot confirm that any file is safe — consider
            scanning anything you run.
          </p>
        </section>
      )}

      {media && (
        <section className="border-t border-[var(--color-border-subtle)] pt-3">
          <p className="mb-2 text-[10px] font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
            Media detected
          </p>
          {media.candidates.length === 0 ? (
            // The honest refusal. Most video on the web is a stream, and saying so
            // is the feature — an empty list reads as a bug, and a button that
            // cannot work is worse than either.
            <p className="text-xs text-[var(--color-text-muted)]">{media.note}</p>
          ) : (
            <ul className="space-y-2">
              {media.candidates.map((candidate) => (
                <li
                  key={candidate.url}
                  className="flex items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] p-2.5"
                >
                  <Icon
                    name={candidate.kind === 'video' ? 'wsMedia' : 'volume'}
                    size={14}
                    className="shrink-0 text-[var(--color-text-muted)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{candidate.label}</span>
                    <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                      {candidate.container ?? 'unknown format'}
                      {candidate.resolution ? ` · ${candidate.resolution}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => download(candidate.url)}
                    className="shrink-0 cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  >
                    Download
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!scan && !media && (
        <p className="text-xs text-[var(--color-text-muted)]">
          Scans the page you are on for download links and downloadable media. Nothing is scanned
          until you ask.
        </p>
      )}
    </div>
  )
}
