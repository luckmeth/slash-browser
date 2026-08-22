import { useEffect, useState } from 'react'
import type { RemoteConfig } from '@shared/types/remoteConfig'
import { useBrowserStore } from '../../stores/browserStore'

/**
 * Configuration whoever publishes this build controls.
 *
 * For the operator, not the person browsing — which is why it is last, in
 * About Slash, and says plainly what it costs. Empty by default: a fresh
 * install never asks anything how it should behave.
 */
export function PublisherSection(): React.JSX.Element {
  const endpoint = useBrowserStore((s) => s.settings?.remoteConfigEndpoint) ?? ''
  const [config, setConfig] = useState<RemoteConfig | null>(null)

  useEffect(() => {
    void window.browser.invoke('config:remote', undefined).then((result) => {
      if (result.ok) setConfig(result.value)
    })
    return window.browser.on('config:changed', setConfig)
  }, [endpoint])

  return (
    <div>
      <label className="block text-[11px] text-[var(--color-text-muted)]">
        Remote configuration endpoint
      </label>
      <input
        value={endpoint}
        onChange={(event) =>
          void window.browser.invoke('settings:update', {
            remoteConfigEndpoint: event.target.value
          })
        }
        placeholder="https://example.com/api/config"
        aria-label="Remote configuration endpoint"
        className="mt-1.5 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
      />

      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Lets whoever publishes this browser change a few things without shipping a new version: the
        start-page notice, whether the &ldquo;Advertise on Slash&rdquo; link appears, and rollout
        flags. <strong>Empty by default</strong> — with nothing here, no request is ever made and
        every value is the local default.
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        The request carries no identifier, no version and no locale, and the answer is identical for
        every caller — so it cannot be used to count or recognise installations. It is checked at
        most once an hour.
      </p>

      {endpoint !== '' && config && (
        <div className="mt-2.5 flex flex-col gap-1 rounded-lg border border-[var(--glass-edge)] px-2.5 py-2 text-[11px] text-[var(--color-text-muted)]">
          <span className="text-[10px] tracking-wide uppercase">Currently in effect</span>
          <span>
            Advertise link: {config.showAdvertiseCta ? 'shown' : 'hidden'}
          </span>
          <span>
            Notice: {config.notice.message === '' ? 'none' : `“${config.notice.message}”`}
          </span>
          <span>
            Flags:{' '}
            {Object.keys(config.flags).length === 0
              ? 'none'
              : Object.entries(config.flags)
                  .map(([name, on]) => `${name}=${on ? 'on' : 'off'}`)
                  .join(', ')}
          </span>
        </div>
      )}
    </div>
  )
}
