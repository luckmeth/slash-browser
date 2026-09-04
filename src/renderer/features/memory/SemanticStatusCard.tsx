import type { SemanticStatus } from '@shared/types/semantic'
import { SEMANTIC_MODEL_LABEL, SEMANTIC_MODEL_MB } from '@shared/types/semantic'

/**
 * The semantic-search control, and the whole truth about it.
 *
 * A card rather than a checkbox because there is a real claim to make and it is
 * worth making properly: this reads your browsing history with a language model,
 * and it does so without a single byte leaving the machine. That is the unusual
 * part, and burying it in a tooltip would waste it.
 */
export function SemanticStatusCard({
  status,
  onSetEnabled
}: {
  status: SemanticStatus | null
  onSetEnabled: (enabled: boolean) => void
}): React.JSX.Element | null {
  if (!status) return null

  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Search by meaning</p>
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
            Finds a page from a paraphrase — “that article about database speed” — as well as from
            the words that were on it.
          </p>
        </div>
        <StateChip status={status} />
      </div>

      <p className="mt-2 text-xs text-[var(--color-text-muted)]">{status.detail}</p>

      {(status.state === 'ready' || status.state === 'indexing') && (
        <dl className="mt-2 space-y-0.5 text-[11px] text-[var(--color-text-muted)]">
          <div className="flex justify-between gap-3">
            <dt>Pages searchable by meaning</dt>
            <dd className="text-[var(--color-text-primary)]">
              {status.embeddedPages.toLocaleString()}
            </dd>
          </div>
          {status.pendingPages > 0 && (
            <div className="flex justify-between gap-3">
              <dt>Still to read</dt>
              <dd className="text-[var(--color-text-primary)]">
                {status.pendingPages.toLocaleString()}
              </dd>
            </div>
          )}
        </dl>
      )}

      {status.state === 'unsupported' ? (
        // No button at all. Offering a switch that cannot work is the thing the
        // honesty rule exists to prevent.
        <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
          Keyword search is unaffected and continues to work normally.
        </p>
      ) : status.state === 'off' ? (
        <>
          <button
            type="button"
            onClick={() => onSetEnabled(true)}
            className="mt-3 w-full cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Turn on
          </button>
          <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
            {SEMANTIC_MODEL_LABEL} ships with Slash — {SEMANTIC_MODEL_MB} MB already on this disk.
            Nothing is downloaded, and no page you visit or word you search for is ever sent
            anywhere. It runs offline.
          </p>
        </>
      ) : (
        <button
          type="button"
          onClick={() => onSetEnabled(status.state === 'error')}
          className="mt-3 w-full cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          {status.state === 'error' ? 'Try again' : 'Turn off'}
        </button>
      )}
    </div>
  )
}

function StateChip({ status }: { status: SemanticStatus }): React.JSX.Element {
  const label: Record<SemanticStatus['state'], string> = {
    unsupported: 'unavailable',
    off: 'off',
    preparing: 'loading',
    indexing: 'reading',
    ready: 'on',
    error: 'failed'
  }
  const tone =
    status.state === 'ready'
      ? 'text-[var(--color-good)]'
      : status.state === 'error'
        ? 'text-[var(--color-bad)]'
        : 'text-[var(--color-text-muted)]'

  return (
    <span
      className={`shrink-0 rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] ${tone}`}
    >
      {label[status.state]}
    </span>
  )
}
