import { useEffect, useState } from 'react'
import {
  PERMISSION_COPY,
  POLICY_COPY,
  type PermissionEvent,
  type PermissionGrant
} from '@shared/types/permission'
import { Icon } from '../../components/Icon'

/**
 * The permissions dashboard: everything currently granted, and the log of how it
 * got that way.
 *
 * The log is append-only and shown in full because "what did I agree to, and
 * when" is only worth anything if the record cannot be quietly rewritten.
 */
export function PermissionsPanel(): React.JSX.Element {
  const [grants, setGrants] = useState<PermissionGrant[]>([])
  const [events, setEvents] = useState<PermissionEvent[]>([])
  const [showLog, setShowLog] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    void window.browser.invoke('permissions:list', undefined).then((result) => {
      if (result.ok) setGrants(result.value)
    })
    return window.browser.on('permissions:changed', (next) => setGrants(next))
  }, [])

  useEffect(() => {
    if (!showLog) return
    void window.browser.invoke('permissions:events', { limit: 100 }).then((result) => {
      if (result.ok) setEvents(result.value)
    })
  }, [showLog, grants])

  // Re-render once a minute so the countdowns stay truthful.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => clearInterval(timer)
  }, [])

  const revoke = (grant: PermissionGrant, reloadTabs: boolean): void => {
    void window.browser
      .invoke('permissions:revoke', {
        partition: grant.partition,
        origin: grant.origin,
        kind: grant.kind,
        reloadTabs
      })
      .then((result) => {
        if (result.ok) setGrants(result.value)
      })
  }

  const byOrigin = new Map<string, PermissionGrant[]>()
  for (const grant of grants) {
    const bucket = byOrigin.get(grant.origin)
    if (bucket) bucket.push(grant)
    else byOrigin.set(grant.origin, [grant])
  }

  return (
    <div className="space-y-4 p-4" data-tick={tick}>
      {grants.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          No site has a standing permission. Anything you allow only for a tab or a session is not
          listed here, because it is never written to disk.
        </p>
      ) : (
        [...byOrigin.entries()].map(([origin, originGrants]) => (
          <section
            key={origin}
            className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3"
          >
            <h3 className="truncate text-sm font-medium" title={origin}>
              {origin}
            </h3>
            {originGrants[0]?.partition !== 'default' && (
              // Grants are keyed by partition, so an isolated workspace keeps
              // its own. Saying which one avoids the confusion of seeing the
              // same site listed twice.
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                In the isolated workspace “{originGrants[0]?.partition.replace('persist:ws-', '')}”
              </p>
            )}

            <ul className="mt-2 space-y-2">
              {originGrants.map((grant) => (
                <li key={grant.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm">{PERMISSION_COPY[grant.kind].label}</p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {grant.policy === 'always-block' ? (
                        <span className="text-[var(--color-bad)]">Blocked</span>
                      ) : (
                        POLICY_COPY[grant.policy]
                      )}
                      {grant.expiresAt !== null && ` · ${remaining(grant.expiresAt)}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => revoke(grant, false)}
                      title="Withdraw this permission"
                      className="cursor-default rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-xs transition hover:border-[var(--color-bad)] hover:text-[var(--color-bad)]"
                    >
                      Withdraw
                    </button>
                    {PERMISSION_COPY[grant.kind].sensitive && grant.policy !== 'always-block' && (
                      <button
                        type="button"
                        onClick={() => revoke(grant, true)}
                        // Chromium caches some grants renderer-side, so a page
                        // already holding a camera stream keeps it until reload.
                        title="Withdraw and reload any open tab on this site, so access stops immediately"
                        className="cursor-default rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                      >
                        Withdraw &amp; reload
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <p className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-3 text-xs text-[var(--color-text-muted)]">
        Withdrawing updates this browser immediately. A page that already holds an open camera or
        microphone stream can keep it until the tab reloads — that state lives in the page, not
        here, which is what “Withdraw &amp; reload” is for.
      </p>

      <div>
        <button
          type="button"
          onClick={() => setShowLog((v) => !v)}
          className="flex w-full cursor-default items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-sm transition hover:border-[var(--color-accent)]"
        >
          <Icon name="clock" size={14} />
          {showLog ? 'Hide' : 'Show'} permission activity
        </button>

        {showLog && (
          <ul className="mt-2 space-y-1">
            {events.length === 0 ? (
              <li className="text-xs text-[var(--color-text-muted)]">Nothing recorded yet.</li>
            ) : (
              events.map((event) => (
                <li key={event.id} className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">
                    <span
                      className={
                        event.action === 'granted'
                          ? 'text-[var(--color-good)]'
                          : event.action === 'denied' || event.action === 'revoked'
                            ? 'text-[var(--color-bad)]'
                            : ''
                      }
                    >
                      {event.action}
                    </span>{' '}
                    {PERMISSION_COPY[event.kind].label.toLowerCase()} · {event.origin}
                  </span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">
                    {new Date(event.at).toLocaleString()}
                  </span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  )
}

function remaining(expiresAt: number): string {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'expired'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes} min left`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${minutes % 60} min left`
}
