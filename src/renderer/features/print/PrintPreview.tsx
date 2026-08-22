import { useCallback, useEffect, useRef, useState } from 'react'
import type { PaperSize, PrintChoices, PrintPreview as Preview } from '@shared/types/print'

const PAPER: PaperSize[] = ['A4', 'A3', 'Letter', 'Legal', 'Tabloid']

const DEFAULTS: PrintChoices = {
  landscape: false,
  paperSize: 'A4',
  scale: 100,
  printBackground: false,
  headerFooter: false,
  copies: 1,
  pageRangeText: ''
}

/**
 * Print preview.
 *
 * The panel on the right is the settings; the sheet on the left is a real PDF,
 * rendered from the page with exactly the choices shown, displayed in Chromium's
 * own viewer. It is what will print — not a guess at it. A preview that can
 * disagree with the printer is worse than none, because it gets believed.
 *
 * Re-rendering is debounced: every change means re-rasterising the whole page,
 * and doing that on each keystroke of the page-range box makes the panel feel
 * broken on a long document.
 */
export function PrintPreview(): React.JSX.Element {
  const [choices, setChoices] = useState<PrintChoices>(DEFAULTS)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [rendering, setRendering] = useState(true)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const latest = useRef(0)

  const close = useCallback((): void => {
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  useEffect(() => {
    const token = ++latest.current
    setRendering(true)
    const timer = setTimeout(() => {
      void window.browser.invoke('print:preview', { choices }).then((result) => {
        // A render that finished after a newer one started is discarded, or the
        // sheet would flick back to the older settings.
        if (token !== latest.current) return
        setRendering(false)
        if (result.ok && result.value) {
          setPreview(result.value)
          setFailed(false)
        } else {
          setFailed(true)
        }
      })
    }, 260)
    return () => clearTimeout(timer)
  }, [choices])

  const set = <K extends keyof PrintChoices>(key: K, value: PrintChoices[K]): void =>
    setChoices((current) => ({ ...current, [key]: value }))

  const pageLabel =
    preview?.pageCount === null || preview?.pageCount === undefined
      ? ''
      : `${preview.pageCount} page${preview.pageCount === 1 ? '' : 's'}`

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/45 p-6" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Print preview"
        className="glass-float animate-rise flex h-full max-h-[760px] w-full max-w-[1000px] overflow-hidden rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* The sheet */}
        <div className="relative flex-1 bg-[var(--color-surface-sunken)]">
          {preview && !failed ? (
            <embed
              key={preview.path}
              src={`file://${preview.path.replace(/\\/g, '/')}#toolbar=0&navpanes=0`}
              type="application/pdf"
              className="h-full w-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <p className="text-xs text-[var(--color-text-muted)]">
                {failed
                  ? 'This page could not be rendered for printing. Some pages — PDFs already open in the viewer, for one — cannot be re-rendered.'
                  : 'Rendering…'}
              </p>
            </div>
          )}
          {rendering && preview && (
            <div className="absolute top-2 right-2 rounded-md bg-black/55 px-2 py-1 text-[10px] text-white">
              Updating…
            </div>
          )}
        </div>

        {/* The choices */}
        <div className="flex w-[264px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--glass-edge)] p-4">
          <div>
            <p className="text-sm font-medium">Print</p>
            <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
              {pageLabel !== '' ? pageLabel : 'Page count unavailable'}
            </p>
          </div>

          <Field label="Pages">
            <input
              value={choices.pageRangeText}
              onChange={(event) => set('pageRangeText', event.target.value)}
              placeholder="All"
              className="w-full rounded-md border border-[var(--glass-edge)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              e.g. 1-3, 5, 8- · leave empty for all
            </p>
          </Field>

          <Field label="Copies">
            <input
              type="number"
              min={1}
              max={99}
              value={choices.copies}
              onChange={(event) => set('copies', Math.max(1, Number(event.target.value) || 1))}
              className="w-full rounded-md border border-[var(--glass-edge)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            />
          </Field>

          <Field label="Paper">
            <select
              value={choices.paperSize}
              onChange={(event) => set('paperSize', event.target.value as PaperSize)}
              className="w-full rounded-md border border-[var(--glass-edge)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            >
              {PAPER.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Layout">
            <div className="flex gap-1.5">
              {([false, true] as const).map((landscape) => (
                <button
                  key={String(landscape)}
                  type="button"
                  onClick={() => set('landscape', landscape)}
                  className={`flex-1 cursor-default rounded-md border px-2 py-1 text-[11px] transition ${
                    choices.landscape === landscape
                      ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                      : 'border-[var(--glass-edge)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
                  }`}
                >
                  {landscape ? 'Landscape' : 'Portrait'}
                </button>
              ))}
            </div>
          </Field>

          <Field label={`Scale · ${choices.scale}%`}>
            <input
              type="range"
              min={10}
              max={200}
              step={5}
              value={choices.scale}
              onChange={(event) => set('scale', Number(event.target.value))}
              className="w-full"
            />
          </Field>

          <Check
            label="Background graphics"
            hint="Off by default: backgrounds turn a readable article into a block of toner."
            checked={choices.printBackground}
            onChange={(value) => set('printBackground', value)}
          />
          <Check
            label="Headers and footers"
            hint="Page title, address and page numbers along the edges."
            checked={choices.headerFooter}
            onChange={(value) => set('headerFooter', value)}
          />

          <div className="mt-auto flex flex-col gap-1.5 pt-3">
            <button
              type="button"
              disabled={busy || failed}
              onClick={() => {
                setBusy(true)
                void window.browser
                  .invoke('print:run', { choices, pageCount: preview?.pageCount ?? 0 })
                  .then((result) => {
                    setBusy(false)
                    // Closes on success only. A failed print that dismissed its
                    // own dialog would leave nothing on screen to explain it.
                    if (result.ok && result.value.ok) close()
                  })
              }}
              className="cursor-default rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[#08111f] transition disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Print'}
            </button>
            <button
              type="button"
              disabled={busy || failed}
              onClick={() => {
                setBusy(true)
                void window.browser.invoke('print:savePdf', { choices }).then((result) => {
                  setBusy(false)
                  if (result.ok && result.value.ok) close()
                })
              }}
              className="cursor-default rounded-md border border-[var(--glass-edge)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] disabled:opacity-50"
            >
              Save as PDF
            </button>
            <button
              type="button"
              onClick={close}
              className="cursor-default rounded-md px-3 py-1.5 text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <p className="mb-1 text-[11px] text-[var(--color-text-muted)]">{label}</p>
      {children}
    </div>
  )
}

function Check({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <label className="flex cursor-default items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 shrink-0"
      />
      <span className="min-w-0">
        <span className="block text-[11px]">{label}</span>
        <span className="mt-0.5 block text-[10px] leading-snug text-[var(--color-text-muted)]">
          {hint}
        </span>
      </span>
    </label>
  )
}
