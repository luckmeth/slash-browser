import { useEffect, useState } from 'react'
import { destinationLabel } from '@shared/ai/loopback'
import type { AiHubStatus, AiProviderId, AiProviderInfo } from '@shared/types/aiHub'
import { Icon } from '../../components/Icon'
import { ComparePanel } from './ComparePanel'

/**
 * AI Hub — connect and manage providers.
 *
 * The browser is not tied to one vendor: Claude, OpenAI, Google and any
 * OpenAI-compatible local model are all rows in the same list, and the user picks
 * which one AI features use.
 *
 * Two things this panel is careful about:
 *
 *  - **It never displays a key**, because no channel returns one. Keys go to the
 *    main process once and are encrypted with the OS keychain immediately.
 *  - **It marks which providers leave the machine — by checking, not by label.**
 *    A local model and a cloud API look identical in a list, and that difference
 *    is the whole reason someone would choose one. The badge is driven by
 *    `loopbackVerdict` over the stored endpoint, because the endpoint is a
 *    free-text field: this panel used to render the catalogue's `local` flag as
 *    "nothing is sent to a third party" beside a URL the user could point
 *    anywhere.
 */
export function AiHubPanel(): React.JSX.Element {
  const [status, setStatus] = useState<AiHubStatus | null>(null)
  const [editing, setEditing] = useState<AiProviderId | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => {
    void window.browser.invoke('aiHub:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  useEffect(refresh, [])

  if (!status) {
    return <p className="p-4 text-sm text-[var(--color-text-muted)]">Loading providers…</p>
  }

  return (
    <div className="space-y-3 p-3">
      {!status.secureStorageAvailable && (
        // Refused rather than degraded. A provider key in readable form beside the
        // browsing history is not a trade this browser makes.
        <p className="rounded-lg border border-[var(--color-bad)] p-2.5 text-[11px] text-[var(--color-bad)]">
          This system offers no secure credential store, so Slash will not save API keys. Local
          models still work — they need no key.
        </p>
      )}

      <p className="text-xs text-[var(--color-text-muted)]">
        {status.defaultProvider
          ? `AI features use ${status.providers.find((p) => p.id === status.defaultProvider)?.name}.`
          : 'No provider connected. Every other feature in Slash works without one.'}
      </p>

      {error && <p className="text-[11px] text-[var(--color-bad)]">{error}</p>}

      <ul className="space-y-2">
        {status.providers.map((provider) => (
          <li
            key={provider.id}
            className="rounded-lg border border-[var(--color-border-subtle)] p-2.5"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  {provider.name}
                  {/*
                    Driven by the *verified* destination, never by
                    `provider.local`. That flag names a provider id; the endpoint
                    beside it is a free-text field, so a "local" provider pointed
                    at a remote box used to carry this badge and its promise.
                  */}
                  {provider.destination === 'loopback' && (
                    <span
                      title={`Runs on this machine (${provider.destinationHost}) — nothing is sent to a third party`}
                      className="rounded border border-[var(--color-good)] px-1 py-0.5 text-[9px] text-[var(--color-good)]"
                    >
                      on-device
                    </span>
                  )}
                  {provider.local && provider.destination === 'remote' && (
                    <span
                      title={`This endpoint is not on your machine. Requests go to ${provider.destinationHost}.`}
                      className="rounded border border-[var(--color-bad)] px-1 py-0.5 text-[9px] text-[var(--color-bad)]"
                    >
                      off-device
                    </span>
                  )}
                  {provider.local && provider.destination === 'unparseable' && (
                    <span
                      title="Slash cannot tell where this endpoint is, so it will not claim anything about it."
                      className="rounded border border-[var(--color-border-subtle)] px-1 py-0.5 text-[9px] text-[var(--color-text-muted)]"
                    >
                      unknown endpoint
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                  {provider.description}
                </p>
              </div>
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
                  provider.connected
                    ? 'border-[var(--color-good)] text-[var(--color-good)]'
                    : 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)]'
                }`}
              >
                {provider.connected ? 'connected' : 'not connected'}
              </span>
            </div>

            {provider.connected && (
              <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
                Model: <span className="text-[var(--color-text-primary)]">{provider.model}</span>
                {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
                {' · '}
                <span
                  className={
                    provider.destination === 'loopback'
                      ? 'text-[var(--color-good)]'
                      : 'text-[var(--color-text-muted)]'
                  }
                >
                  {destinationLabel(provider.destination, provider.destinationHost)}
                </span>
              </p>
            )}

            {editing === provider.id ? (
              <ConnectForm
                provider={provider}
                onCancel={() => setEditing(null)}
                onSubmit={(payload) => {
                  setError(null)
                  void window.browser
                    .invoke('aiHub:connect', { provider: provider.id, ...payload })
                    .then((result) => {
                      if (!result.ok) return
                      setStatus(result.value.status)
                      setError(result.value.error)
                      if (!result.value.error) setEditing(null)
                    })
                }}
              />
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Action
                  label={provider.connected ? 'Change key or model' : 'Connect'}
                  onClick={() => {
                    setError(null)
                    setEditing(provider.id)
                  }}
                />
                {provider.connected && status.defaultProvider !== provider.id && (
                  <Action
                    label="Use for AI features"
                    onClick={() =>
                      void window.browser
                        .invoke('aiHub:setDefault', { provider: provider.id })
                        .then((result) => {
                          if (result.ok) {
                            setStatus(result.value.status)
                            setError(result.value.error)
                          }
                        })
                    }
                  />
                )}
                {provider.connected && (
                  <Action
                    label="Disconnect"
                    onClick={() =>
                      void window.browser
                        .invoke('aiHub:disconnect', { provider: provider.id })
                        .then((result) => {
                          if (result.ok) setStatus(result.value)
                        })
                    }
                  />
                )}
                {provider.keyUrl && !provider.connected && (
                  <Action
                    label="Get a key"
                    onClick={() =>
                      void window.browser.invoke('tabs:create', {
                        url: provider.keyUrl!,
                        background: false
                      })
                    }
                  />
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <section className="border-t border-[var(--color-border-subtle)] pt-3">
        <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
          Compare answers
        </h3>
        <ComparePanel providers={status.providers} />
      </section>

      <p className="border-t border-[var(--color-border-subtle)] pt-2 text-[11px] text-[var(--color-text-muted)]">
        Keys are encrypted by your operating system's credential store and never shown again, not
        even here. Nothing is sent to a provider until you approve each request.
      </p>
    </div>
  )
}

/** Key, model and endpoint entry for one provider. */
function ConnectForm({
  provider,
  onSubmit,
  onCancel
}: {
  provider: AiProviderInfo
  onSubmit: (payload: { apiKey?: string; model?: string; baseUrl?: string }) => void
  onCancel: () => void
}): React.JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(provider.model)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '')

  return (
    <div className="mt-2 space-y-1.5">
      {provider.requiresKey && (
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={provider.connected ? 'New API key (leave blank to keep)' : 'API key'}
          aria-label={`${provider.name} API key`}
          // Never rendered back from storage — this field is write-only.
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
        />
      )}

      <input
        list={`models-${provider.id}`}
        value={model}
        onChange={(event) => setModel(event.target.value)}
        placeholder="Model"
        aria-label={`${provider.name} model`}
        className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
      />
      <datalist id={`models-${provider.id}`}>
        {provider.suggestedModels.map((suggested) => (
          <option key={suggested} value={suggested} />
        ))}
      </datalist>

      {provider.local && (
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://localhost:11434/v1"
          aria-label="Local endpoint"
          className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
        />
      )}

      <div className="flex gap-1.5">
        <Action
          label="Save"
          onClick={() =>
            onSubmit({
              ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {}),
              model: model.trim(),
              ...(provider.local ? { baseUrl: baseUrl.trim() } : {})
            })
          }
        />
        <Action label="Cancel" onClick={onCancel} />
      </div>
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
      <span className="flex items-center gap-1">
        {label === 'Disconnect' && <Icon name="close" size={9} />}
        {label}
      </span>
    </button>
  )
}
