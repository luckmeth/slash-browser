import { useEffect, useState } from 'react'
import type { PageInsight } from '@shared/types/pageInsight'
import { useBrowserStore } from '../../stores/browserStore'

/**
 * Page Insight.
 *
 * Two honesty rules shape this panel:
 *
 *  - **It is not labelled "AI Analysis", because no AI is involved.** Calling
 *    local pattern matching an AI reading would invite the user to trust it as
 *    though something had understood the page. It says what it detected.
 *  - **Every finding shows whether the page *declared* it or Slash *detected*
 *    it.** "The page marks these links rel=sponsored" and "these URLs look like
 *    affiliate links" are very different claims, and collapsing them would
 *    accuse honest sites of hiding things.
 */
export function PageInsightPanel(): React.JSX.Element {
  const [insight, setInsight] = useState<PageInsight | null>(null)
  const [busy, setBusy] = useState(false)
  const activeTab = useBrowserStore((s) => s.activeTab())

  const analyse = (): void => {
    setBusy(true)
    void window.browser.invoke('insight:analyse', undefined).then((result) => {
      setBusy(false)
      if (result.ok) setInsight(result.value)
    })
  }

  // Re-read when the page changes; insight about a page you have left is wrong.
  useEffect(analyse, [activeTab?.url])

  if (busy && !insight) {
    return <p className="p-4 text-sm text-[var(--color-text-muted)]">Reading this page…</p>
  }
  if (!insight) {
    return <p className="p-4 text-sm text-[var(--color-text-muted)]">Nothing read yet.</p>
  }
  if (insight.note) {
    return <p className="p-4 text-sm text-[var(--color-text-muted)]">{insight.note}</p>
  }

  return (
    <div className="space-y-4 p-3">
      <section>
        <p className="text-sm font-medium">{insight.title || insight.host}</p>
        <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
          {insight.siteName ?? insight.host} · {insight.wordCount.toLocaleString()} words ·{' '}
          {insight.readingMinutes} min read
        </p>
        {insight.summary && (
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">{insight.summary}</p>
        )}
      </section>

      {insight.shopping && (
        <section>
          <Heading>Shopping details</Heading>
          <dl className="space-y-1 text-[11px]">
            {insight.shopping.productName && (
              <Row label="Product" value={insight.shopping.productName} />
            )}
            {/* Exactly as the page wrote it. A browser showing a different number
                from the page would be the worst kind of bug on a checkout screen. */}
            {insight.shopping.price && <Row label="Price on page" value={insight.shopping.price} />}
            {insight.shopping.availability && (
              <Row label="Availability" value={insight.shopping.availability} />
            )}
            <Row
              label="Recurring charge"
              value={insight.shopping.subscription ? 'Wording suggests yes' : 'Not indicated'}
            />
            <Row
              label="Returns mentioned"
              value={insight.shopping.mentionsReturns ? 'Yes' : 'Not on this page'}
            />
            <Row
              label="Cancellation mentioned"
              value={insight.shopping.mentionsCancellation ? 'Yes' : 'Not on this page'}
            />
          </dl>
          <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
            Read from the page's own structured data. Check the terms themselves before buying.
          </p>
        </section>
      )}

      {insight.signals.length > 0 && (
        <section>
          <Heading>What stood out</Heading>
          <ul className="space-y-2">
            {insight.signals.map((signal, index) => (
              <li
                key={index}
                className="rounded-lg border border-[var(--color-border-subtle)] p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-medium">{signal.label}</p>
                  <span
                    // The distinction the whole panel turns on.
                    title={
                      signal.strength === 'declared'
                        ? 'The page states this about itself in its own markup'
                        : 'Slash matched a pattern — it may be wrong'
                    }
                    className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
                      signal.strength === 'declared'
                        ? 'border-[var(--color-good)] text-[var(--color-good)]'
                        : 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)]'
                    }`}
                  >
                    {signal.strength === 'declared' ? 'page declares' : 'detected'}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{signal.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {insight.outline.length > 0 && (
        <section>
          <Heading>What this page covers</Heading>
          <ul className="space-y-0.5">
            {insight.outline.slice(0, 20).map((entry, index) => (
              <li
                key={index}
                style={{ paddingLeft: `${(entry.level - 1) * 10}px` }}
                className="truncate text-[11px] text-[var(--color-text-muted)]"
              >
                {entry.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {insight.linkedHosts.length > 0 && (
        <section>
          <Heading>Links out to</Heading>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {insight.externalLinkCount} external link
            {insight.externalLinkCount === 1 ? '' : 's'} across {insight.linkedHosts.length} site
            {insight.linkedHosts.length === 1 ? '' : 's'}: {insight.linkedHosts.join(', ')}
          </p>
        </section>
      )}

      <p className="border-t border-[var(--color-border-subtle)] pt-2 text-[11px] text-[var(--color-text-muted)]">
        Read from this page's visible content and markup by Slash itself — no AI, and nothing sent
        anywhere. These are signals, not conclusions: independent verification is recommended.
      </p>

      <button
        type="button"
        disabled={busy}
        onClick={analyse}
        className="w-full cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
      >
        {busy ? 'Reading…' : 'Read this page again'}
      </button>
    </div>
  )
}

function Heading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
      {children}
    </h3>
  )
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className="text-right text-[var(--color-text-primary)]">{value}</dd>
    </div>
  )
}
