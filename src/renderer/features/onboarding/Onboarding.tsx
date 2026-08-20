import { useCallback, useEffect, useState } from 'react'
import type { ImportSource, ImportSummary } from '@shared/types/importer'
import type { Settings } from '@shared/types/settings'
import { SEARCH_ENGINES, type SearchEngineId } from '@shared/constants'
import { BrandMark } from '../../components/BrandMark'
import { Icon, type IconName } from '../../components/Icon'

/**
 * The first-run walkthrough.
 *
 * Renders in the **overlay view**, not the chrome document. On a first launch
 * the content hole usually shows the chrome-drawn new tab page, where CSS would
 * be fine — but a restored session puts a real page view there, and a native
 * view composites above the DOM. The one case that breaks is the one where the
 * user has the most to lose, so it goes where nothing can cover it.
 *
 * Four screens, all skippable, none of which asks for anything. Nothing here
 * enables a feature that sends data anywhere: the AI layer, page indexing and
 * semantic search all stay off until asked for elsewhere, and this screen does
 * not offer to turn them on. An onboarding flow is the easiest place in a
 * product to smuggle in a default-on opt-in, so it deliberately has no power to.
 */

type Step = 'welcome' | 'import' | 'search' | 'sleep'

const ORDER: Step[] = ['welcome', 'import', 'search', 'sleep']

export function Onboarding(): React.JSX.Element {
  const [step, setStep] = useState<Step>('welcome')
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    void window.browser.invoke('settings:getAll', undefined).then((result) => {
      if (result.ok) setSettings(result.value)
    })
  }, [])

  const finish = useCallback((): void => {
    // Recorded before the overlay closes, so a crash between the two does not
    // bring the walkthrough back on the next launch.
    void window.browser
      .invoke('settings:update', { onboardingCompleted: true })
      .then(() => window.browser.invoke('overlay:setState', { visible: false, surface: 'none' }))
  }, [])

  const index = ORDER.indexOf(step)
  const next = (): void => {
    const following = ORDER[index + 1]
    if (following) setStep(following)
    else finish()
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/45 p-6">
      <div className="glass-float animate-rise w-full max-w-lg rounded-2xl p-7">
        {step === 'welcome' && <Welcome />}
        {step === 'import' && <ImportStep />}
        {step === 'search' && (
          <SearchStep
            current={settings?.searchEngineId ?? 'google'}
            onPick={(id) => {
              setSettings((prev) => (prev ? { ...prev, searchEngineId: id } : prev))
              void window.browser.invoke('settings:update', { searchEngineId: id })
            }}
          />
        )}
        {step === 'sleep' && <SleepStep />}

        <div className="mt-7 flex items-center gap-3">
          <div className="flex gap-1.5" aria-hidden="true">
            {ORDER.map((id) => (
              <span
                key={id}
                className={`h-1.5 rounded-full transition-all ${
                  id === step ? 'w-5 bg-[var(--color-accent)]' : 'w-1.5 bg-white/20'
                }`}
              />
            ))}
          </div>
          <div className="flex-1" />
          {/* Skip is present on every screen, not buried on the first. */}
          <button
            type="button"
            onClick={finish}
            className="cursor-default rounded-lg px-3 py-1.5 text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={next}
            className="cursor-default rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-black transition hover:brightness-110"
          >
            {index === ORDER.length - 1 ? 'Start browsing' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Welcome(): React.JSX.Element {
  return (
    <div>
      <BrandMark size={40} className="text-[var(--color-text-primary)]" />
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Welcome to Slash</h1>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
        A browser that organises tabs, sleeps the ones you are not using, and keeps what it learns
        about your browsing on this machine.
      </p>
      {/* The claim this product actually rests on, said first. */}
      <p className="mt-4 rounded-xl border border-[var(--glass-edge)] bg-white/5 p-3 text-xs leading-relaxed text-[var(--color-text-muted)]">
        Nothing leaves this device unless you turn it on. Page indexing, semantic search and the AI
        features all start switched off, and this walkthrough will not switch any of them on.
      </p>
    </div>
  )
}

function ImportStep(): React.JSX.Element {
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<ImportSummary | null>(null)

  useEffect(() => {
    void window.browser.invoke('import:sources', undefined).then((result) => {
      setSources(result.ok ? result.value : [])
    })
  }, [])

  return (
    <div>
      <StepIcon name="download" />
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Bring your bookmarks over</h1>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
        Slash can copy bookmarks and history from a browser already on this machine.
      </p>

      {sources === null && (
        <p className="mt-4 text-xs text-[var(--color-text-muted)]">Looking for browsers…</p>
      )}

      {sources !== null && sources.length === 0 && (
        <p className="mt-4 text-xs text-[var(--color-text-muted)]">
          No other browser profiles were found. You can import later from Settings.
        </p>
      )}

      {done && (
        <p className="mt-4 rounded-xl border border-[var(--glass-edge)] bg-white/5 p-3 text-xs text-[var(--color-text-muted)]">
          Imported {done.bookmarksAdded} bookmark{done.bookmarksAdded === 1 ? '' : 's'} and{' '}
          {done.historyAdded.toLocaleString()} history entries. Bookmarks arrive in their own dated
          folder, so nothing is mixed into yours.
        </p>
      )}

      {sources !== null && sources.length > 0 && !done && (
        <div className="mt-4 flex max-h-44 flex-col gap-1.5 overflow-y-auto">
          {sources.map((source) => (
            <button
              key={source.id}
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setBusy(source.id)
                void window.browser
                  .invoke('import:run', {
                    sourceId: source.id,
                    bookmarks: source.hasBookmarks,
                    history: source.hasHistory
                  })
                  .then((result) => {
                    setBusy(null)
                    if (result.ok) setDone(result.value)
                  })
              }}
              className="glass-raised flex cursor-default items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-[var(--glass-high)] disabled:opacity-50"
            >
              <Icon name="globe" size={14} className="shrink-0 text-[var(--color-text-muted)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{source.browser}</span>
                <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                  {source.profile}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
                {busy === source.id ? 'Importing…' : 'Import'}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Stated up front rather than discovered later at a bad moment. */}
      <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Bookmarks and history only. Saved passwords are not copied — they are encrypted to your
        Windows account, and lifting a password store is not something this browser does on the
        strength of one button.
      </p>
    </div>
  )
}

function SearchStep({
  current,
  onPick
}: {
  current: SearchEngineId
  onPick: (id: SearchEngineId) => void
}): React.JSX.Element {
  return (
    <div>
      <StepIcon name="search" />
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Pick a search engine</h1>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
        What the address bar uses when you type something that is not an address.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-1.5">
        {(Object.keys(SEARCH_ENGINES) as SearchEngineId[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            className={`cursor-default rounded-xl border px-3 py-2.5 text-left text-[13px] transition ${
              current === id
                ? 'border-[var(--color-accent)] bg-[var(--glass-high)]'
                : 'border-[var(--glass-edge)] hover:bg-white/[0.06]'
            }`}
          >
            {SEARCH_ENGINES[id].name}
          </button>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">
        You can change this any time in Settings.
      </p>
    </div>
  )
}

function SleepStep(): React.JSX.Element {
  return (
    <div>
      <StepIcon name="moon" />
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Tabs sleep on their own</h1>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
        Tabs you have not touched for a while are put to sleep to free memory. They stay in the
        strip, and clicking one brings it straight back — with its scroll position and history.
      </p>
      {/* The exact guards, because the fear here is "will it eat what I typed". */}
      <ul className="mt-4 flex flex-col gap-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
        <Guard>A tab with something typed into it is never slept.</Guard>
        <Guard>Playing audio or video keeps a tab awake.</Guard>
        <Guard>Pinned tabs, and anything you mark Never Sleep, are left alone.</Guard>
      </ul>
      <p className="mt-4 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Sleeping a tab frees real memory and Slash reports the measured figure. Sites cannot be made
        to restore anything they kept only in the page, so a half-finished form in a slept tab is
        the site&apos;s to remember, not ours.
      </p>
    </div>
  )
}

function Guard({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <li className="flex gap-2">
      <Icon name="shield" size={13} className="mt-0.5 shrink-0 text-[var(--color-good)]" />
      <span>{children}</span>
    </li>
  )
}

function StepIcon({ name }: { name: IconName }): React.JSX.Element {
  return (
    <span className="flex size-10 items-center justify-center rounded-xl bg-[var(--glass-high)]">
      <Icon name={name} size={18} className="text-[var(--color-accent)]" />
    </span>
  )
}
