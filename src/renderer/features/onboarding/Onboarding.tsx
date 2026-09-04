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

type Step = 'welcome' | 'import' | 'search' | 'sleep' | 'downloads' | 'default'

const ORDER: Step[] = ['welcome', 'import', 'search', 'sleep', 'downloads', 'default']

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
        {step === 'downloads' && <DownloadsStep />}
        {step === 'sleep' && <SleepStep />}
        {step === 'default' && <DefaultBrowserStep />}

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
      {/*
        The claim this product rests on, said first — and it had to be narrowed
        when sponsored placements became always-on. It used to read "nothing
        leaves this device unless you turn it on", which stopped being true the
        moment the browser fetched an advert batch on launch without being
        asked. Overstating this is worse than the revenue is worth: it is the
        one sentence a reader would quote back if they caught it.
      */}
      <p className="mt-4 rounded-xl border border-[var(--glass-edge)] bg-white/5 p-3 text-xs leading-relaxed text-[var(--color-text-muted)]">
        Your history, bookmarks and passwords stay on this machine. Page indexing, semantic search
        and the AI features all start switched off, and this walkthrough will not switch any of
        them on.
      </p>
      <p className="mt-2 rounded-xl border border-[var(--glass-edge)] bg-white/5 p-3 text-xs leading-relaxed text-[var(--color-text-muted)]">
        Slash is funded by sponsored placements, so it does fetch a batch of adverts periodically.
        Nothing about you is part of that request — no history, no page address, no identifier — and
        what goes back is a daily count of how often each advert was shown.
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
  /**
   * May be one of the user's own engines, since the default is a free-form id
   * now. First run only offers the built-ins, so an unrecognised value simply
   * highlights nothing rather than being coerced.
   */
  current: string
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

/**
 * The last screen: an offer to become the default browser.
 *
 * It opens Windows' own screen and says so. There is no button here that makes
 * Slash the default, because Windows has not allowed an application to do that
 * since Windows 8 — the association is signed against the user and the ProgId,
 * and anything written from code is silently reverted. Every browser you have
 * installed hits this wall; the ones that pretend otherwise are the ones that
 * leave you wondering why nothing changed.
 *
 * Skipped entirely where it does not apply, or where Slash already is the
 * default — a walkthrough screen offering something already done is worse than
 * one screen fewer.
 */
function DefaultBrowserStep(): React.JSX.Element {
  const [status, setStatus] = useState<{ isDefault: boolean; supported: boolean } | null>(null)
  const [opened, setOpened] = useState(false)

  useEffect(() => {
    void window.browser.invoke('system:defaultBrowser', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }, [])

  if (status?.isDefault === true || status?.supported === false) {
    return (
      <div>
        <StepIcon name="globe" />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">You are set up</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
          {status.isDefault
            ? 'Slash is already your default browser, so links from other applications will open here.'
            : 'Everything is ready. You can change any of this later in Settings.'}
        </p>
      </div>
    )
  }

  return (
    <div>
      <StepIcon name="globe" />
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Make Slash your default</h1>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
        Links you click in other applications — mail, chat, documents — will open here instead of
        the browser you were using.
      </p>

      <button
        type="button"
        onClick={() => {
          setOpened(true)
          void window.browser
            .invoke('system:openDefaultBrowserSettings', undefined)
            .then(() =>
              setTimeout(() => {
                void window.browser
                  .invoke('system:refreshDefaultBrowser', undefined)
                  .then((result) => {
                    if (result.ok) setStatus(result.value)
                  })
              }, 5000)
            )
        }}
        className="mt-4 w-full cursor-pointer rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-black transition hover:opacity-90"
      >
        Open Windows settings
      </button>

      {/* Said before the click, not after it. The step that trips people up is
          the one Windows owns, and finding that out afterwards feels like the
          button did not work. */}
      <p className="mt-3 rounded-xl border border-[var(--glass-edge)] bg-white/5 p-3 text-xs leading-relaxed text-[var(--color-text-muted)]">
        {opened
          ? 'Windows should now be open. Find Slash in the list and set it for http and https — Windows requires that last step to happen there, not here.'
          : 'Windows does not let an application make itself the default. This opens the Settings screen where you can choose Slash; the final click has to be yours.'}
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

/**
 * Offers the optional downloader, once, where it will actually be seen.
 *
 * Buried in Settings it is a feature nobody finds. Here it is a choice made
 * knowingly at the point of install, which is also the honest place for it:
 * this installs a separate program, and that should be a decision rather than
 * something the browser did on its own.
 */
function DownloadsStep(): React.JSX.Element {
  const [status, setStatus] = useState<{ installed: boolean; version: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    void window.browser.invoke('external:status', undefined).then((result) => {
      if (result.ok) setStatus({ installed: result.value.installed, version: result.value.version })
    })
  }, [])

  const install = (): void => {
    setBusy(true)
    setNote('Fetching the current release…')
    void window.browser.invoke('external:install', undefined).then((result) => {
      setBusy(false)
      if (result.ok) {
        setNote(result.value.note)
        void window.browser.invoke('settings:update', { useExternalDownloader: true })
        setStatus({ installed: true, version: result.value.version })
      } else {
        // The failed branch is an `Err`, which carries no value — reading one
        // off it was a typecheck error, and would have been an empty message.
        setNote('yt-dlp could not be installed. You can try again in Settings.')
      }
    })
  }

  return (
    <div>
      <h2 className="text-lg font-semibold">Downloading videos</h2>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
        Slash downloads video from most sites on its own, with a proper download manager — resumable,
        multi-connection, and a picker for the quality.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
        A few sites, YouTube among them, serve video in a form no browser can turn into a file by
        itself. For those Slash can use <strong>yt-dlp</strong>, a well-known open-source tool. It is
        optional, it is not part of Slash, and you can add or remove it later in Settings.
      </p>

      {status?.installed === true ? (
        <p className="mt-4 text-sm text-[var(--color-accent)]">
          yt-dlp {status.version ?? ''} is ready.
        </p>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={install}
          className="mt-4 cursor-pointer rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-black transition disabled:opacity-50"
        >
          {busy ? 'Installing…' : 'Install yt-dlp (about 18 MB)'}
        </button>
      )}

      {note !== null && (
        <p className="mt-3 text-xs text-[var(--color-text-muted)]" role="status">
          {note}
        </p>
      )}
      <p className="mt-3 text-xs leading-relaxed text-[var(--color-text-muted)]">
        Downloaded from the project's official releases and checked against its published checksum.
        Skip this and everything else still works.
      </p>
    </div>
  )
}
