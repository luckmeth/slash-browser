import { useEffect, useState } from 'react'
import type { ChainVerdict, RedirectChain } from '@shared/types/redirectChain'
import { Icon } from '../../components/Icon'

const VERDICT: Record<ChainVerdict, { label: string; tone: string }> = {
  ordinary: { label: 'ordinary', tone: 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)]' },
  // Its own label rather than "ordinary", so the panel can explain why a
  // five-domain chain is expected during sign-in.
  authentication: { label: 'sign-in flow', tone: 'border-[var(--color-good)] text-[var(--color-good)]' },
  notable: { label: 'worth a look', tone: 'border-[var(--color-accent)] text-[var(--color-accent)]' },
  suspicious: { label: 'suspicious', tone: 'border-[var(--color-bad)] text-[var(--color-bad)]' }
}

const KIND_LABEL: Record<string, string> = {
  permanent: '301/308 permanent',
  temporary: '302/307 temporary',
  client: 'client-side',
  unknown: 'redirect'
}

/**
 * Redirect X-Ray.
 *
 * Shows where a navigation actually went. Multi-hop cross-domain chains are both
 * how tracking works and how every sign-in on the web works, so the panel's real
 * job is telling those apart — and it labels a recognised authentication flow as
 * such rather than warning about it. A warning that fires during OAuth teaches
 * the user to dismiss redirect warnings entirely.
 */
export function RedirectXRayPanel(): React.JSX.Element {
  const [chains, setChains] = useState<RedirectChain[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = (): void => {
    void window.browser.invoke('redirects:chains', undefined).then((result) => {
      if (result.ok) setChains(result.value)
    })
  }

  useEffect(() => {
    refresh()
    // Pushed as chains complete, so the panel is live while browsing.
    return window.browser.on('redirects:chain', () => refresh())
  }, [])

  const blockDomain = (host: string): void => {
    void window.browser.invoke('redirects:blockDomain', { host }).then(refresh)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border-subtle)] p-3">
        <p className="text-xs text-[var(--color-text-muted)]">
          Every redirect your navigations passed through. Direct loads are not listed — only pages
          that arrived via at least one redirect.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {chains.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No redirect chains recorded yet. Browse for a while and anything that redirects will
            appear here.
          </p>
        ) : (
          <ul className="space-y-2">
            {chains.map((chain) => (
              <li
                key={chain.id}
                className="rounded-lg border border-[var(--color-border-subtle)] p-2.5"
              >
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === chain.id ? null : chain.id)}
                  className="w-full cursor-default text-left"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 truncate text-sm">
                      {chain.domains[0] ?? '—'}
                      {chain.domains.length > 1 && (
                        <span className="text-[var(--color-text-muted)]">
                          {' → '}
                          {chain.domains[chain.domains.length - 1]}
                        </span>
                      )}
                    </p>
                    <span
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${VERDICT[chain.verdict].tone}`}
                    >
                      {VERDICT[chain.verdict].label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                    {chain.hops.length - 1} redirect{chain.hops.length - 1 === 1 ? '' : 's'} ·{' '}
                    {new Date(chain.startedAt).toLocaleTimeString()}
                  </p>
                </button>

                {chain.reasons.map((reason, index) => (
                  <p key={index} className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    {reason}
                  </p>
                ))}

                {expanded === chain.id && (
                  <>
                    {/* The chain itself, as a route rather than a list — the
                        shape is what makes a detour obvious at a glance. */}
                    <ol className="mt-2 space-y-1 border-l border-[var(--color-border-subtle)] pl-3">
                      {chain.hops.map((hop, index) => (
                        <li key={index} className="relative">
                          <span className="absolute -left-[15px] top-1.5 size-1.5 rounded-full bg-[var(--color-accent)]" />
                          <p className="truncate text-[11px] text-[var(--color-text-primary)]">
                            {hop.host || hop.url}
                          </p>
                          <p className="truncate text-[10px] text-[var(--color-text-muted)]">
                            {index === 0
                              ? 'started here'
                              : index === chain.hops.length - 1
                                ? 'final destination'
                                : KIND_LABEL[hop.kind] ?? 'redirect'}
                            {hop.statusCode ? ` · ${hop.statusCode}` : ''}
                          </p>
                        </li>
                      ))}
                    </ol>

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Action
                        label="Return to the original page"
                        onClick={() =>
                          void window.browser.invoke('tabs:create', {
                            url: chain.originalUrl,
                            background: false
                          })
                        }
                      />
                      {/* Blocking is offered per intermediate domain, never for
                          the destination or the origin — blocking either would
                          break the page the user was trying to reach. */}
                      {chain.domains.slice(1, -1).map((domain) => (
                        <Action
                          key={domain}
                          label={`Block ${domain}`}
                          onClick={() => blockDomain(domain)}
                        />
                      ))}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {chains.length > 0 && (
        <div className="border-t border-[var(--color-border-subtle)] p-3">
          <button
            type="button"
            onClick={() => void window.browser.invoke('redirects:clear', undefined).then(refresh)}
            className="flex w-full cursor-default items-center justify-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-bad)] hover:text-[var(--color-bad)]"
          >
            <Icon name="close" size={12} />
            Clear recorded chains
          </button>
        </div>
      )}
    </div>
  )
}

function Action({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
    >
      {label}
    </button>
  )
}
