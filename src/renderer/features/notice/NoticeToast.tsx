import { useEffect, useState } from 'react'

/**
 * A transient message, shown over the page.
 *
 * Here rather than in the chrome document because a native page view composites
 * above the DOM, so anything drawn in the chrome that extended over a page would
 * simply not appear — the same trap the shield and cleanup panels each fell into.
 *
 * Its overlay is a small strip and deliberately **not modal**, so the page
 * underneath stays clickable while this is up.
 */
export function NoticeToast(): React.JSX.Element | null {
  const [notice, setNotice] = useState<{
    message: string
    tone: 'info' | 'warn'
    action: { label: string; downloadUrl: string; openUrl: string } | null
  } | null>(null)
  const [taken, setTaken] = useState(false)

  useEffect(() => {
    void window.browser.invoke('notice:current', undefined).then((result) => {
      if (result.ok && result.value.message !== '') setNotice(result.value)
    })
  }, [])

  useEffect(() => {
    if (!notice) return
    // Long enough to read a sentence, short enough not to sit on the page. It
    // dismisses itself: a toast that has to be closed is a dialog.
    //
    // A notice offering to *do* something waits longer, because reading it is
    // no longer the whole task — four seconds to notice, decide and click is
    // an offer designed to be missed.
    const timer = setTimeout(
      () => {
        void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
      },
      notice.action ? 9000 : 4200
    )
    return () => clearTimeout(timer)
  }, [notice])

  if (!notice) return null

  return (
    <div className="flex h-full w-full items-end justify-center p-3">
      <div
        role="status"
        aria-live="polite"
        className={`glass-float animate-rise w-full rounded-xl px-3.5 py-2.5 text-[12px] leading-snug ${
          notice.tone === 'warn' ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-primary)]'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1">{notice.message}</span>
          {notice.action && (
            <button
              type="button"
              disabled={taken}
              onClick={() => {
                setTaken(true)
                const close = (): void => {
                  void window.browser.invoke('overlay:setState', {
                    visible: false,
                    surface: 'none'
                  })
                }
                // Two kinds of offer share this button: enqueue a download, or
                // open a page. Which one is decided by the notice, not sniffed
                // from the string.
                const open = notice.action?.openUrl ?? ''
                if (open !== '') {
                  void window.browser
                    .invoke('tabs:create', { url: open, background: false })
                    .then(close)
                  return
                }
                void window.browser
                  .invoke('downloadEngine:enqueue', {
                    url: notice.action?.downloadUrl ?? '',
                    priority: 'normal',
                    startAfter: null
                  })
                  .then(close)
              }}
              className="shrink-0 cursor-pointer rounded-md border border-[var(--color-accent)] px-2 py-1 text-[11px] text-[var(--color-accent)] transition disabled:opacity-50"
            >
              {taken ? (notice.action.openUrl !== '' ? 'Opening…' : 'Queued') : notice.action.label}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
