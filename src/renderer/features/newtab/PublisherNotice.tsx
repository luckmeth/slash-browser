import { useEffect, useState } from 'react'
import type { RemoteConfig } from '@shared/types/remoteConfig'

/**
 * A message from whoever publishes this build.
 *
 * The other half of the operations app's "Browser config" page — without
 * something reading it, that screen edited a table nothing consumed, which is a
 * switch that does nothing dressed up as an operations tool.
 *
 * Shown only when there is a message, so a default install and an operator with
 * nothing to say both render nothing at all. Dismissible, and the dismissal
 * sticks for that particular message: a notice that came back on every new tab
 * would be an advert.
 */
export function PublisherNotice(): React.JSX.Element | null {
  const [notice, setNotice] = useState<RemoteConfig['notice'] | null>(null)
  const [dismissed, setDismissed] = useState('')

  useEffect(() => {
    setDismissed(localStorage.getItem('slash.notice.dismissed') ?? '')
    void window.browser.invoke('config:remote', undefined).then((result) => {
      if (result.ok) setNotice(result.value.notice)
    })
    return window.browser.on('config:changed', (config) => setNotice(config.notice))
  }, [])

  if (!notice || notice.message.trim() === '') return null
  if (dismissed === notice.message) return null

  const tone =
    notice.level === 'urgent'
      ? 'border-[var(--color-warn)] text-[var(--color-warn)]'
      : notice.level === 'warn'
        ? 'border-[var(--color-warn)] text-[var(--color-warn)]'
        : 'border-[var(--glass-edge)] text-[var(--color-text-muted)]'

  return (
    <div
      role="status"
      className={`animate-rise mt-6 flex w-full items-start gap-3 rounded-xl border px-3.5 py-2.5 text-[12px] leading-snug ${tone}`}
    >
      <span className="min-w-0 flex-1">
        {notice.message}
        {notice.url !== '' && (
          <>
            {' '}
            <button
              type="button"
              onClick={() =>
                void window.browser.invoke('tabs:create', { url: notice.url, background: false })
              }
              className="cursor-default underline decoration-dotted underline-offset-2"
            >
              Read more
            </button>
          </>
        )}
      </span>
      <button
        type="button"
        aria-label="Dismiss this notice"
        onClick={() => {
          localStorage.setItem('slash.notice.dismissed', notice.message)
          setDismissed(notice.message)
        }}
        className="shrink-0 cursor-default opacity-70 transition hover:opacity-100"
      >
        ✕
      </button>
    </div>
  )
}
