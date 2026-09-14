import { useEffect, useState } from 'react'
import {
  PERMISSION_COPY,
  POLICY_COPY,
  type PermissionPolicy,
  type PermissionRequest
} from '@shared/types/permission'

/**
 * Offered in order of increasing commitment.
 *
 * `allow-for-session` was implemented end to end — the schema knows it, the
 * store honours it, `POLICY_COPY` has its sentence — and was missing from this
 * list, so no user could ever choose it. CLAUDE.md's rule applies: a capability
 * with no way to reach it is an unfinished feature, not spare capacity. It sits
 * between "this tab" and "one hour" because that is where it falls on the scale
 * this list is ordered by.
 */
const ALLOW_POLICIES: PermissionPolicy[] = [
  'allow-once',
  'allow-for-tab',
  'allow-for-session',
  'allow-until',
  'always-allow'
]

/**
 * The permission prompt.
 *
 * Rendered in the overlay because it must appear over the page that asked, and
 * the page is a native view the chrome document cannot draw on top of.
 *
 * Two rules shape the copy:
 *  - it states what the access *enables*, never what the site intends. We cannot
 *    know a site's motive and implying otherwise would be false confidence.
 *  - "Not now" is the default action and the visually prominent one. A prompt
 *    that nudges toward granting is a dark pattern.
 */
export function PermissionPrompt(): React.JSX.Element | null {
  const [request, setRequest] = useState<PermissionRequest | null>(null)

  useEffect(() => {
    void window.browser.invoke('permissions:getPending', undefined).then((result) => {
      if (result.ok) setRequest(result.value)
    })
    return window.browser.on('permissions:prompt', (next) => setRequest(next))
  }, [])

  if (!request) return null

  const respond = (policy: PermissionPolicy): void => {
    setRequest(null)
    void window.browser.invoke('permissions:respond', { requestId: request.requestId, policy })
  }

  const combined = request.kinds.length > 1
  const anySensitive = request.kinds.some((kind) => PERMISSION_COPY[kind].sensitive)

  return (
    <div className="flex h-full w-full items-start justify-center bg-black/40 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-title"
        className="w-[420px] max-w-full rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-5 shadow-2xl"
      >
        <p className="truncate text-xs text-[var(--color-text-muted)]" title={request.origin}>
          {request.origin}
        </p>
        <h2 id="permission-title" className="mt-1 text-base font-semibold">
          {combined
            ? `This site wants to ${request.kinds.map((k) => PERMISSION_COPY[k].label.replace(/^Use your |^/, '').toLowerCase()).join(' and ')}`
            : PERMISSION_COPY[request.kinds[0]!].label}
        </h2>

        <ul className="mt-2 space-y-2">
          {request.kinds.map((kind) => (
            <li key={kind} className="text-sm text-[var(--color-text-muted)]">
              {/* The label is only repeated when there are several, where it is
                  needed to tell the consequences apart. For a single permission
                  the heading already said it. */}
              {combined && (
                <span className="text-[var(--color-text-primary)]">
                  {PERMISSION_COPY[kind].label}.{' '}
                </span>
              )}
              {PERMISSION_COPY[kind].consequence}
            </li>
          ))}
        </ul>

        {combined && (
          // Honest about the engine's limit rather than offering per-item
          // toggles that Chromium would ignore.
          <p className="mt-3 rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
            The site asked for both at once, so they can only be allowed or refused together.
          </p>
        )}

        <div className="mt-4 flex flex-col gap-1.5">
          {ALLOW_POLICIES.map((policy) => (
            <button
              key={policy}
              type="button"
              onClick={() => respond(policy)}
              className="cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-left text-sm transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Allow — <span className="text-[var(--color-text-muted)]">{POLICY_COPY[policy]}</span>
            </button>
          ))}
        </div>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            autoFocus
            onClick={() => respond('block')}
            className="flex-1 cursor-default rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-black transition hover:opacity-90"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={() => respond('always-block')}
            className="cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-sm text-[var(--color-text-muted)] transition hover:border-[var(--color-bad)] hover:text-[var(--color-bad)]"
          >
            Never
          </button>
        </div>

        {anySensitive && (
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">
            You can review or withdraw this at any time in Settings → Permissions.
          </p>
        )}
      </div>
    </div>
  )
}
