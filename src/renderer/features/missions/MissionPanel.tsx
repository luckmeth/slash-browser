import { useEffect, useState } from 'react'
import type { MissionStatus } from '@shared/types/mission'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * Mission Mode.
 *
 * A goal, the pages that gathered around it, a for-later pile, and notes.
 *
 * The panel never presents a digression as a transgression. Off-mission pages are
 * offered a home in "saved for later" and nothing else happens — no blocking, no
 * counter of how often you strayed. A browser that scolds is one people stop
 * using, and the feature only works if the occasional prompt is still worth
 * reading.
 */
export function MissionPanel(): React.JSX.Element {
  const [status, setStatus] = useState<MissionStatus | null>(null)
  const [goal, setGoal] = useState('')
  const [notes, setNotes] = useState('')
  const activeTab = useBrowserStore((s) => s.activeTab())

  const refresh = (): void => {
    void window.browser.invoke('mission:status', undefined).then((result) => {
      if (result.ok) {
        setStatus(result.value)
        setNotes(result.value.active?.notes ?? '')
      }
    })
  }

  useEffect(() => {
    refresh()
    return window.browser.on('mission:suggestion', refresh)
  }, [activeTab?.url])

  const call = (
    channel: 'mission:complete' | 'mission:saveForLater',
  ): void => {
    void window.browser.invoke(channel, undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  if (!status) return <p className="p-4 text-sm text-[var(--color-text-muted)]">Loading…</p>

  if (!status.active) {
    return (
      <div className="space-y-2 p-3">
        <p className="text-sm">What are you trying to get done?</p>
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Slash will keep the pages that belong to it together, hold your notes, and offer to save
          anything unrelated for later. It never blocks a site.
        </p>
        <input
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || goal.trim() === '') return
            void window.browser.invoke('mission:start', { goal: goal.trim() }).then((result) => {
              if (result.ok) {
                setStatus(result.value)
                setGoal('')
              }
            })
          }}
          placeholder="Finish my research paper"
          aria-label="Mission goal"
          className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />

        {status.past.length > 0 && (
          <section className="pt-2">
            <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
              Finished
            </h3>
            <ul className="space-y-1">
              {status.past.slice(0, 6).map((mission) => (
                <li key={mission.id} className="text-[11px] text-[var(--color-text-muted)]">
                  {mission.goal} · {mission.pages.length} page
                  {mission.pages.length === 1 ? '' : 's'}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    )
  }

  const mission = status.active

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border-subtle)] p-3">
        <p className="text-sm font-medium">{mission.goal}</p>
        <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
          {mission.pages.length} page{mission.pages.length === 1 ? '' : 's'} ·{' '}
          {mission.saved.length} saved for later · started{' '}
          {new Date(mission.createdAt).toLocaleDateString()}
        </p>

        {status.suggestion && (
          // The entire intervention: an offer, on the page it is about.
          <div className="mt-2 rounded-lg border border-[var(--color-accent)] p-2.5">
            <p className="text-[11px]">{status.suggestion}</p>
            <div className="mt-1.5 flex gap-1.5">
              <Action label="Save for later" onClick={() => call('mission:saveForLater')} />
              <Action label="Keep browsing" onClick={refresh} />
            </div>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <section>
          <Heading>Pages in this mission</Heading>
          {mission.pages.length === 0 ? (
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Nothing yet — pages related to your goal are added as you visit them.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {mission.pages.slice(0, 20).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() =>
                      void window.browser.invoke('tabs:create', {
                        url: item.url,
                        background: false
                      })
                    }
                    className="w-full cursor-default truncate text-left text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                  >
                    {item.title || hostOf(item.url)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {mission.saved.length > 0 && (
          <section>
            <Heading>Saved for later</Heading>
            <ul className="space-y-0.5">
              {mission.saved.map((item) => (
                <li key={item.id} className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      void window.browser.invoke('tabs:create', {
                        url: item.url,
                        background: false
                      })
                    }
                    className="min-w-0 flex-1 cursor-default truncate text-left text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                  >
                    {item.title || hostOf(item.url)}
                  </button>
                  <button
                    type="button"
                    aria-label="Remove"
                    onClick={() =>
                      void window.browser
                        .invoke('mission:removeItem', { itemId: item.id })
                        .then((result) => {
                          if (result.ok) setStatus(result.value)
                        })
                    }
                    className="shrink-0 cursor-default text-[var(--color-text-muted)] hover:text-[var(--color-bad)]"
                  >
                    <Icon name="close" size={9} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <Heading>Notes</Heading>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            onBlur={() =>
              void window.browser
                .invoke('mission:setNotes', { id: mission.id, notes })
                .then((result) => {
                  if (result.ok) setStatus(result.value)
                })
            }
            rows={5}
            placeholder="What you have worked out so far…"
            className="w-full resize-none rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
          />
        </section>
      </div>

      <div className="border-t border-[var(--color-border-subtle)] p-3">
        <button
          type="button"
          onClick={() => call('mission:complete')}
          className="w-full cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          Finish this mission
        </button>
      </div>
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
