import { useEffect, useState } from 'react'
import type { ActionPlan, AiStatus, EgressPreview } from '@shared/types/ai'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * The AI action surface.
 *
 * Enforces the pipeline in the UI as well as in the engine:
 * UNDERSTAND → PLAN → **PREVIEW** → APPROVE → EXECUTE → REPORT.
 *
 * Nothing runs from typing a request. The preview is a separate, explicit step,
 * and Cancel is always available and always does nothing.
 */
export function AiPanel(): React.JSX.Element {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [request, setRequest] = useState('')
  const [plan, setPlan] = useState<ActionPlan | null>(null)
  const [egress, setEgress] = useState<EgressPreview | null>(null)
  const [includeContent, setIncludeContent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<{ messages: string[]; canUndo: boolean } | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const settings = useBrowserStore((s) => s.settings)

  const refreshStatus = (): void => {
    void window.browser.invoke('ai:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  useEffect(refreshStatus, [settings?.aiProvider])

  useEffect(() => {
    void window.browser
      .invoke('ai:egressPreview', { includePageContent: includeContent })
      .then((result) => {
        if (result.ok) setEgress(result.value)
      })
  }, [includeContent, request])

  // --- not configured: setup, and nothing else ------------------------------
  if (status && !status.configured) {
    return (
      <div className="space-y-4 p-4">
        <div>
          <h3 className="text-sm font-medium">AI is off</h3>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            The browser works fully without it. Nothing is sent anywhere until you configure a
            provider here, and even then only when you ask it to do something — and only after you
            approve what it proposes.
          </p>
        </div>

        <label className="block">
          <span className="text-xs text-[var(--color-text-muted)]">Provider</span>
          <select
            value={settings?.aiProvider ?? 'none'}
            onChange={(event) =>
              void window.browser
                .invoke('settings:update', {
                  aiProvider: event.target.value as 'none' | 'anthropic' | 'openai-compatible'
                })
                .then(refreshStatus)
            }
            className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm"
          >
            <option value="none">None — AI disabled</option>
            <option value="anthropic">Anthropic (your own API key)</option>
            <option value="openai-compatible">Local model (Ollama / LM Studio)</option>
          </select>
        </label>

        {settings?.aiProvider === 'anthropic' && (
          <label className="block">
            <span className="text-xs text-[var(--color-text-muted)]">API key</span>
            <div className="mt-1 flex gap-2">
              <input
                type="password"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
                placeholder="sk-ant-…"
                className="flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <button
                type="button"
                onClick={() => {
                  void window.browser
                    .invoke('ai:setApiKey', { key: keyDraft })
                    .then((result) => {
                      if (result.ok && !result.value.stored) setError(result.value.reason)
                      setKeyDraft('')
                      refreshStatus()
                    })
                }}
                className="cursor-default rounded-md bg-[var(--color-accent)] px-3 text-sm font-medium text-black"
              >
                Save
              </button>
            </div>
            {/* Says where it goes, because "we store it securely" means nothing
                without saying how. */}
            <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
              Encrypted with your operating system's credential store, never written in plain text,
              and never sent back to this window.
            </span>
          </label>
        )}

        {settings?.aiProvider === 'openai-compatible' && (
          <label className="block">
            <span className="text-xs text-[var(--color-text-muted)]">Server address</span>
            <input
              defaultValue={settings.aiBaseUrl}
              onBlur={(event) =>
                void window.browser
                  .invoke('settings:update', { aiBaseUrl: event.target.value })
                  .then(refreshStatus)
              }
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
              With a local model nothing leaves this machine at all.
            </span>
          </label>
        )}

        {error && <p className="text-xs text-[var(--color-bad)]">{error}</p>}
      </div>
    )
  }

  // --- configured ------------------------------------------------------------
  const submit = (): void => {
    if (request.trim() === '') return
    setBusy(true)
    setError(null)
    setReport(null)
    void window.browser
      .invoke('ai:propose', { request, includePageContent: includeContent })
      .then((result) => {
        setBusy(false)
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        if (result.value.error) setError(result.value.error)
        setPlan(result.value.plan)
      })
  }

  return (
    <div className="space-y-3 p-4">
      <div>
        <textarea
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          rows={2}
          placeholder="Organise my tabs"
          className="w-full resize-none rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              checked={includeContent}
              disabled={!status?.mayReadPageContent}
              onChange={(event) => setIncludeContent(event.target.checked)}
            />
            Include page text
            {!status?.mayReadPageContent && ' (enable in Settings first)'}
          </label>
          <button
            type="button"
            disabled={busy || request.trim() === ''}
            onClick={submit}
            className="cursor-default rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40"
          >
            {busy ? 'Thinking…' : 'Propose'}
          </button>
        </div>
      </div>

      {/* Shown before anything is sent, not after. */}
      {egress && !plan && (
        <details className="rounded-lg border border-[var(--color-border-subtle)] p-2.5">
          <summary className="cursor-default text-xs text-[var(--color-text-muted)]">
            What gets sent to the provider
          </summary>
          <ul className="mt-1.5 space-y-0.5">
            {egress.lines.map((line, index) => (
              <li key={index} className="text-xs text-[var(--color-text-muted)]">
                • {line}
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && (
        <p className="rounded-lg border border-[var(--color-bad)] p-2 text-xs text-[var(--color-bad)]">
          {error}
        </p>
      )}

      {plan && (
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
          <p className="text-xs text-[var(--color-text-muted)]">It understood:</p>
          <p className="mt-0.5 text-sm">{plan.understanding}</p>

          {plan.refusal ? (
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">{plan.refusal}</p>
          ) : (
            <>
              <p className="mt-3 text-xs font-medium tracking-wide uppercase">Proposed changes</p>
              <ul className="mt-1 space-y-1">
                {plan.preview.map((line, index) => (
                  <li key={index} className="flex gap-2 text-sm">
                    <span className={line.mutating ? 'text-amber-400' : 'text-[var(--color-good)]'}>
                      •
                    </span>
                    <span>{line.text}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="mt-3 flex gap-2">
            {!plan.refusal && (
              <button
                type="button"
                onClick={() => {
                  void window.browser
                    .invoke('ai:approve', { planId: plan.planId })
                    .then((result) => {
                      setPlan(null)
                      if (result.ok) {
                        setReport({
                          messages: result.value.messages,
                          canUndo: result.value.canUndo
                        })
                      }
                    })
                }}
                className="cursor-default rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-black"
              >
                Apply
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                void window.browser.invoke('ai:cancel', { planId: plan.planId })
                setPlan(null)
              }}
              className="cursor-default rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-sm transition hover:border-[var(--color-bad)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {report && (
        <div className="rounded-lg border border-[var(--color-border-subtle)] p-3">
          <p className="text-xs font-medium tracking-wide uppercase">Done</p>
          <ul className="mt-1 space-y-0.5">
            {report.messages.map((message, index) => (
              <li key={index} className="text-sm text-[var(--color-text-muted)]">
                {message}
              </li>
            ))}
          </ul>
          {report.canUndo && (
            <button
              type="button"
              onClick={() => {
                void window.browser.invoke('ai:undo', undefined).then(() => setReport(null))
              }}
              className="mt-2 flex cursor-default items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              <Icon name="back" size={11} />
              Undo
            </button>
          )}
        </div>
      )}

      <p className="text-xs text-[var(--color-text-muted)]">
        This assistant can only group, move, close, bookmark and reorder tabs. It cannot send
        messages, buy anything, fill in forms, change settings or delete your data — those are not
        capabilities it has, not rules it is asked to follow.
      </p>
    </div>
  )
}
