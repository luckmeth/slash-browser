import { useEffect, useState } from 'react'
import type { ReaderArticle, ReaderBlock } from '@shared/types/reader'
import { hostOf } from '@shared/url'
import { Icon } from '../../components/Icon'

/**
 * Reader mode.
 *
 * Renders the article as text nodes — never as markup. The content came from a
 * web page and this document holds the privileged IPC bridge, so page-derived
 * HTML is not something to hand to `dangerouslySetInnerHTML` however well
 * sanitised it arrived. React escapes every string here by construction.
 *
 * What that costs is stated to the user rather than hidden: images and inline
 * links do not survive the trip.
 */
export function Reader(): React.JSX.Element | null {
  const [article, setArticle] = useState<ReaderArticle | null>(null)
  const [reason, setReason] = useState<string | null>(null)

  useEffect(() => {
    void window.browser.invoke('reader:get', undefined).then((result) => {
      if (!result.ok) return
      setArticle(result.value.article)
      setReason(result.value.reason)
    })
  }, [])

  const close = (): void => {
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!article) {
    return reason ? (
      <div className="flex h-full w-full items-center justify-center bg-[var(--color-surface)] p-8">
        <p className="max-w-sm text-center text-sm text-[var(--color-text-muted)]">{reason}</p>
      </div>
    ) : null
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-[var(--color-surface)]">
      <div className="mx-auto max-w-[46rem] px-6 py-10">
        <div className="mb-6 flex items-start justify-between gap-4">
          <p className="text-xs text-[var(--color-text-muted)]">
            {article.siteName ?? hostOf(article.url)} · {article.readingMinutes} min read
            {article.byline ? ` · ${article.byline}` : ''}
          </p>
          <button
            type="button"
            onClick={close}
            title="Close reader (Esc)"
            aria-label="Close reader"
            className="shrink-0 cursor-default rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <Icon name="close" size={12} />
          </button>
        </div>

        <h1 className="mb-6 text-3xl leading-tight font-semibold text-balance">{article.title}</h1>

        <article className="space-y-4">
          {article.blocks.map((block, index) => (
            <Block key={index} block={block} />
          ))}
        </article>

        <p className="mt-10 border-t border-[var(--color-border-subtle)] pt-4 text-[11px] text-[var(--color-text-muted)]">
          Reader mode shows the text of this page. Images, inline links and layout are left behind —
          close the reader to go back to the page itself.
        </p>
      </div>
    </div>
  )
}

/**
 * One block, sized by what it is.
 *
 * Reading comfort is the entire feature, so the measure is capped, the line
 * height is generous, and headings keep the hierarchy the author gave them
 * rather than being flattened to bold text.
 */
function Block({ block }: { block: ReaderBlock }): React.JSX.Element {
  switch (block.kind) {
    case 'heading': {
      const size =
        block.level <= 2 ? 'text-xl' : block.level === 3 ? 'text-lg' : 'text-base'
      return <h2 className={`${size} pt-4 font-semibold`}>{block.text}</h2>
    }
    case 'quote':
      return (
        <blockquote className="border-l-2 border-[var(--color-accent)] pl-4 text-[15px] leading-7 text-[var(--color-text-muted)] italic">
          {block.text}
        </blockquote>
      )
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs">
          <code>{block.text}</code>
        </pre>
      )
    case 'list-item':
      return (
        <p className="flex gap-2 text-[17px] leading-8">
          <span className="text-[var(--color-text-muted)]">•</span>
          <span>{block.text}</span>
        </p>
      )
    case 'paragraph':
    default:
      return <p className="text-[17px] leading-8">{block.text}</p>
  }
}
