import { useState } from 'react'
import type { Settings } from '@shared/types/settings'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

type CustomEngine = Settings['customSearchEngines'][number]

/**
 * Your own search engines, triggered by typing their keyword first.
 *
 * "gh react hooks" searches GitHub without disturbing the default engine. The
 * keyword only counts when followed by a space, which is what keeps a keyword
 * of "gh" from swallowing `github.com`.
 */
export function SearchEnginesSection(): React.JSX.Element {
  const settings = useBrowserStore((s) => s.settings)
  const [name, setName] = useState('')
  const [keyword, setKeyword] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const engines = settings?.customSearchEngines ?? []

  const save = (next: CustomEngine[]): void => {
    void window.browser.invoke('settings:update', { customSearchEngines: next })
  }

  const add = (): void => {
    // Keywords are normalised here, once, so the matcher never has to cope with
    // whitespace or case it did not expect.
    const cleanKeyword = keyword.trim().toLowerCase().replace(/\s+/g, '')
    const cleanUrl = url.trim()
    if (cleanKeyword === '' || cleanUrl === '') {
      setError('A keyword and an address are both needed.')
      return
    }
    if (engines.some((engine) => engine.keyword === cleanKeyword)) {
      setError(`"${cleanKeyword}" is already used by another engine.`)
      return
    }
    if (!/^https?:\/\//i.test(cleanUrl)) {
      setError('The address must start with http:// or https://')
      return
    }

    setError(null)
    save([
      ...engines,
      {
        id: `cse-${Date.now().toString(36)}`,
        name: name.trim() || cleanKeyword,
        keyword: cleanKeyword,
        url: cleanUrl
      }
    ])
    setName('')
    setKeyword('')
    setUrl('')
  }

  return (
    <div>
      {engines.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1">
          {engines.map((engine) => (
            <li
              key={engine.id}
              className="group flex items-center gap-2 rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5"
            >
              <code className="shrink-0 rounded bg-white/8 px-1.5 py-0.5 text-[11px]">
                {engine.keyword}
              </code>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{engine.name}</span>
                <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                  {engine.url}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${engine.name}`}
                onClick={() => save(engines.filter((e) => e.id !== engine.id))}
                className="shrink-0 cursor-default rounded p-1 text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100 hover:bg-white/15 focus:opacity-100"
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex gap-1.5">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="gh"
            aria-label="Keyword"
            className="w-16 shrink-0 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="GitHub"
            aria-label="Engine name"
            className="min-w-0 flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://github.com/search?q=%s"
          aria-label="Search URL"
          className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        {error && <p className="text-[11px] text-[var(--color-danger)]">{error}</p>}
        <button
          type="button"
          onClick={add}
          className="self-start cursor-default rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs transition hover:bg-white/10"
        >
          Add engine
        </button>
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        <code>%s</code> is where your search goes. If you leave it out, the search is added to the
        end. Type the keyword then a space to use it — so a site whose name starts with your
        keyword still opens normally.
      </p>
    </div>
  )
}
