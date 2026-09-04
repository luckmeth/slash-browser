import { useState } from 'react'
import type { AiComparison, ComparePreview } from '@shared/types/aiCompare'
import type { AiProviderId, AiProviderInfo } from '@shared/types/aiHub'

/**
 * Ask several providers the same question.
 *
 * The confirmation step is not ceremony. Asking three providers sends the same
 * text to three separate companies, each with its own retention policy, and that
 * is a materially different act from asking one — so the recipients are named and
 * confirmed per request rather than behind a setting switched on once.
 *
 * Answers are shown side by side with their timings and never merged: the point
 * is to see where providers disagree, and a synthesised "consensus" would hide
 * exactly the thing worth looking at.
 */
export function ComparePanel({
  providers
}: {
  providers: readonly AiProviderInfo[]
}): React.JSX.Element | null {
  const connected = providers.filter((provider) => provider.connected)
  const [question, setQuestion] = useState('')
  const [selected, setSelected] = useState<Set<AiProviderId>>(
    new Set(connected.map((provider) => provider.id))
  )
  const [preview, setPreview] = useState<ComparePreview | null>(null)
  const [result, setResult] = useState<AiComparison | null>(null)
  const [busy, setBusy] = useState(false)

  // Nothing to compare with fewer than two providers, and offering the surface
  // anyway would be a button that cannot do what it says.
  if (connected.length < 2) {
    return (
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Connect a second provider to compare answers side by side.
      </p>
    )
  }

  const toggle = (id: AiProviderId): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const askPreview = (): void => {
    if (question.trim() === '' || selected.size === 0) return
    void window.browser
      .invoke('aiHub:comparePreview', {
        question: question.trim(),
        providers: [...selected]
      })
      .then((response) => {
        if (response.ok) setPreview(response.value)
      })
  }

  const send = (): void => {
    setBusy(true)
    setPreview(null)
    void window.browser
      .invoke('aiHub:compare', { question: question.trim(), providers: [...selected] })
      .then((response) => {
        setBusy(false)
        if (response.ok) setResult(response.value)
      })
  }

  return (
    <div className="space-y-2">
      <textarea
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        rows={3}
        placeholder="Which of these laptops is best for development?"
        aria-label="Question to compare"
        className="w-full resize-none rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
      />

      <div className="flex flex-wrap gap-1.5">
        {connected.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => toggle(provider.id)}
            className={`cursor-default rounded border px-1.5 py-0.5 text-[10px] transition ${
              selected.has(provider.id)
                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                : 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)]'
            }`}
          >
            {provider.name}
            {provider.local ? ' (on-device)' : ''}
          </button>
        ))}
      </div>

      {preview ? (
        // The disclosure, shown before anything leaves. Named recipients, and the
        // count of those that are third parties.
        <div className="rounded-lg border border-[var(--color-accent)] p-2.5">
          <p className="text-[11px] font-medium">You are about to send this question to:</p>
          <ul className="mt-1 space-y-0.5">
            {preview.recipients.map((recipient) => (
              <li key={recipient.provider} className="text-[11px] text-[var(--color-text-muted)]">
                · {recipient.name}
                {/*
                  Named, not implied. "Leaves your machine" tells somebody that
                  something happened; the host tells them what they are agreeing
                  to. Driven by the verified verdict — see the handler.
                */}
                {recipient.local
                  ? ` — stays on this machine${recipient.host ? ` (${recipient.host})` : ''}`
                  : ` — sent to ${recipient.host || 'a third party'}`}
              </li>
            ))}
          </ul>
          {preview.cloudCount > 0 && (
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              {preview.cloudCount === 1
                ? 'One of these is a third-party service with its own retention policy.'
                : `${preview.cloudCount} of these are separate companies, each with its own retention policy.`}
            </p>
          )}
          <div className="mt-2 flex gap-1.5">
            <Action label="Send" onClick={send} />
            <Action label="Cancel" onClick={() => setPreview(null)} />
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy || question.trim() === '' || selected.size === 0}
          onClick={askPreview}
          className="w-full cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
        >
          {busy ? 'Asking…' : `Ask ${selected.size} provider${selected.size === 1 ? '' : 's'}`}
        </button>
      )}

      {result && (
        <section className="space-y-2 pt-1">
          {result.answers.map((answer) => (
            <div
              key={answer.provider}
              className="rounded-lg border border-[var(--color-border-subtle)] p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium">
                  {answer.providerName}
                  <span className="ml-1 font-normal text-[var(--color-text-muted)]">
                    {answer.model}
                  </span>
                </p>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                  {(answer.elapsedMs / 1000).toFixed(1)}s
                  {answer.local ? ' · on-device' : ''}
                </span>
              </div>
              {answer.state === 'answered' ? (
                <p className="mt-1 whitespace-pre-wrap text-[11px] text-[var(--color-text-muted)]">
                  {answer.text}
                </p>
              ) : (
                // A failure is its own row rather than a missing one: an answer
                // silently absent would read as agreement with the others.
                <p className="mt-1 text-[11px] text-[var(--color-bad)]">{answer.error}</p>
              )}
            </div>
          ))}
          <p className="text-[11px] text-[var(--color-text-muted)]">
            Answers are shown as given and are not merged. Where they disagree, that disagreement is
            the useful part — none of them is checked for accuracy.
          </p>
        </section>
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
