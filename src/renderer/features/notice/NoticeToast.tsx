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
  const [notice, setNotice] = useState<{ message: string; tone: 'info' | 'warn' } | null>(null)

  useEffect(() => {
    void window.browser.invoke('notice:current', undefined).then((result) => {
      if (result.ok && result.value.message !== '') setNotice(result.value)
    })
  }, [])

  useEffect(() => {
    if (!notice) return
    // Long enough to read a sentence, short enough not to sit on the page. It
    // dismisses itself: a toast that has to be closed is a dialog.
    const timer = setTimeout(() => {
      void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
    }, 4200)
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
        {notice.message}
      </div>
    </div>
  )
}
