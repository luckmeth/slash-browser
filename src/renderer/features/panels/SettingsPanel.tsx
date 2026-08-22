import { createContext, useContext, useState } from 'react'
import type { Settings } from '@shared/types/settings'
import { SEARCH_ENGINES } from '@shared/constants'
import { SEMANTIC_MODEL_MB } from '@shared/types/semantic'
import { useBrowserStore } from '../../stores/browserStore'
import { useSemanticStatus } from '../memory/useSemanticStatus'
import { ImportSection } from './ImportSection'
import { SearchEnginesSection } from './SearchEnginesSection'
import { SiteZoomSection } from './SiteZoomSection'
import { ToolbarSection } from './ToolbarSection'
import { PasswordsSection } from './PasswordsSection'
import { NewTabSection } from './NewTabSection'
import { SponsorSection } from './SponsorSection'
import { ExtensionsSection } from './ExtensionsSection'
import { DiagnosticsSection } from './DiagnosticsSection'
import { UpdateSection } from './UpdateSection'

export function SettingsPanel(): React.JSX.Element {
  const settings = useBrowserStore((s) => s.settings)
  const { status: semantic, setEnabled: setSemanticEnabled } = useSemanticStatus()
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState<Category>('Appearance')

  if (!settings) return <p className="p-4 text-sm text-[var(--color-text-muted)]">Loading…</p>

  const update = (patch: Partial<Settings>): void => {
    void window.browser.invoke('settings:update', patch)
  }

  return (
    <SettingsFilter.Provider value={filter}>
     <SettingsCategory.Provider value={category}>
      <div className="mx-auto flex h-full w-full max-w-5xl gap-6 p-6">
        {/*
          A category rail, as Chrome and Brave have. Seventeen groups in one
          scroll is a list rather than a settings screen, and it was the least
          usable part of the browser because of it.
        */}
        <nav className="w-48 shrink-0" aria-label="Settings categories">
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <ul className="mt-3 flex flex-col gap-0.5">
            {CATEGORIES.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  aria-current={filter.trim() === '' && category === name ? 'page' : undefined}
                  onClick={() => {
                    // Choosing a category clears the search, or the rail would
                    // appear not to respond while results from elsewhere showed.
                    setFilter('')
                    setCategory(name)
                  }}
                  className={`w-full cursor-default rounded-lg px-3 py-2 text-left text-[13px] transition ${
                    filter.trim() === '' && category === name
                      ? 'bg-[var(--glass-high)] text-[var(--color-text-primary)]'
                      : 'text-[var(--color-text-muted)] hover:bg-white/[0.06]'
                  }`}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
          {filter.trim() !== '' && (
            <p className="mt-3 px-1 text-[11px] leading-snug text-[var(--color-text-muted)]">
              Showing matches from every category.
            </p>
          )}
        </nav>

        <div className="min-w-0 flex-1 space-y-6 overflow-y-auto pb-8">
      <Group title="Appearance">
        <Field label="Accent colour">
          {/* Swatches rather than a dropdown: the thing being chosen is a
              colour, so showing the colours is the whole point. */}
          <div className="flex flex-wrap gap-1.5">
            {ACCENT_SWATCHES.map(([id, hex]) => (
              <button
                key={id}
                type="button"
                title={id}
                aria-label={id}
                aria-pressed={settings.accentColor === id}
                onClick={() => update({ accentColor: id as Settings['accentColor'] })}
                style={{ background: hex }}
                className={`size-6 cursor-default rounded-full transition ${
                  settings.accentColor === id
                    ? 'ring-2 ring-[var(--color-text-primary)] ring-offset-2 ring-offset-[var(--color-surface)]'
                    : 'hover:scale-110'
                }`}
              />
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
            A workspace with its own colour overrides this while you are in it.
          </p>
        </Field>

        <Field label="Density">
          <select
            value={settings.uiDensity}
            onChange={(event) =>
              update({ uiDensity: event.target.value as Settings['uiDensity'] })
            }
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact — more on screen</option>
          </select>
        </Field>

        <Field label="Tab strip">
          <select
            value={settings.tabStripPosition}
            onChange={(event) =>
              update({
                tabStripPosition: event.target.value as Settings['tabStripPosition']
              })
            }
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            <option value="top">Across the top</option>
            <option value="left">Down the left side</option>
          </select>
          <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
            Vertical keeps titles readable past a dozen tabs, at the cost of some window width.
          </p>
        </Field>

        <Field label={`Glass ${settings.glassOpacity}%`}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={settings.glassOpacity}
            onChange={(event) => update({ glassOpacity: Number(event.target.value) })}
            className="w-full accent-[var(--color-accent)]"
          />
          {/* Said outright because it is a performance setting as much as a
              taste one, and that is not obvious from a slider. */}
          <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
            Lower is more transparent. At 100% the blur is switched off entirely, which is the
            faster setting on an older machine and on Windows 10, where the effect is ignored
            anyway.
          </p>
        </Field>
      </Group>

      {/*
        Near the top on purpose. This is the first thing someone needs on a new
        install and the least useful thing on their five-hundredth launch, so it
        belongs where a new user will actually see it.
      */}
      <Group title="Import from another browser">
        <ImportSection />
      </Group>

      <Group title="Search">
        <Field label="Search engine">
          <select
            value={settings.searchEngineId}
            onChange={(event) =>
              update({ searchEngineId: event.target.value })
            }
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            {Object.entries(SEARCH_ENGINES).map(([id, engine]) => (
              <option key={id} value={id}>
                {engine.name}
              </option>
            ))}
            {/* The user's own engines can be the default too. That is what makes
                a search partnership possible: the deal pays against a URL
                carrying your code, and it only earns if searches actually go
                there rather than needing a keyword typed first. */}
            {settings.customSearchEngines.length > 0 && (
              <optgroup label="Your engines">
                {settings.customSearchEngines.map((engine) => (
                  <option key={engine.id} value={engine.id}>
                    {engine.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>

        <Field label="Your own engines">
          <SearchEnginesSection />
        </Field>
      </Group>

      <Group title="Zoom">
        <SiteZoomSection />
      </Group>

      <Group title="Start page">
        <NewTabSection />
      </Group>

      <Group title="Sponsored tiles">
        <SponsorSection />
      </Group>

      <Group title="Extensions">
        <ExtensionsSection />
      </Group>

      <Group title="Toolbar">
        <ToolbarSection />
      </Group>

      <Group title="Saved sign-ins">
        <PasswordsSection />
      </Group>

      <Group title="Content blocking">
        <Toggle
          label="Block ads and trackers"
          hint="Requests are cancelled before they leave your machine, so they cost no bandwidth or time."
          checked={settings.blockAds}
          onChange={(blockAds) => update({ blockAds })}
        />
        <Toggle
          label="Refuse known-malicious sites"
          hint="Checks the address against a list of known-bad domains."
          checked={settings.blockMaliciousSites}
          onChange={(blockMaliciousSites) => update({ blockMaliciousSites })}
        />
        {/*
          Given its own switch rather than being implied by the shield settings,
          because it is the one capability that reaches inside a page.
        */}
        <Toggle
          label="Let Slash run scripts inside pages"
          hint="Needed to remove YouTube's ad breaks, and to stop a blocked popup from breaking the link you clicked. Turning this off also frees the debugger connection Slash keeps on each tab."
          checked={settings.allowPageScripts}
          onChange={(allowPageScripts) => update({ allowPageScripts })}
        />
        {/*
          Said plainly, because a shield icon invites the assumption that this is
          antivirus. It is not, and a browser cannot be.
        */}
        <p className="pt-1 text-xs text-[var(--color-text-muted)]">
          This is not a virus scanner. A browser cannot inspect a file for malware — keep Windows
          Security on for that. The malicious-site list is also small and bundled; real coverage
          needs a continuously updated feed, which this build does not have.
        </p>
      </Group>

      <Group title="Browsing memory">
        <Toggle
          label="Make visited pages searchable"
          hint="Records the address and title of pages you visit."
          checked={settings.indexHistory}
          onChange={(indexHistory) => update({ indexHistory })}
        />
        <Toggle
          label="Also index page text"
          hint="Lets you find a page by words that were on it, not just its title. Stored only on this device."
          checked={settings.indexPageContent}
          disabled={!settings.indexHistory}
          onChange={(indexPageContent) => update({ indexPageContent })}
        />
        <Toggle
          label="Keep private windows out of memory"
          checked={settings.excludePrivateFromMemory}
          onChange={(excludePrivateFromMemory) => update({ excludePrivateFromMemory })}
        />
        {/*
          Driven through its own channel rather than `settings:update`, because
          enabling it starts a download and the panel has to be able to show the
          progress and the failure. The handler writes the same setting, so the
          two routes cannot disagree.
        */}
        <Toggle
          label="Search by meaning as well as by words"
          hint={
            semantic?.state === 'unsupported'
              ? semantic.detail
              : semantic?.state === 'off' || !semantic
                ? `Runs a ${SEMANTIC_MODEL_MB} MB model that ships with Slash — offline, nothing sent anywhere. Works on titles alone, but far better with page text indexing on.`
                : semantic.detail
          }
          checked={
            semantic !== null && semantic.state !== 'off' && semantic.state !== 'unsupported'
          }
          disabled={semantic === null || semantic.state === 'unsupported'}
          onChange={setSemanticEnabled}
        />
      </Group>

      <Group title="Restore points">
        <Toggle
          label="Reopen tabs from the last session"
          checked={settings.restoreTabsOnStartup}
          onChange={(restoreTabsOnStartup) => update({ restoreTabsOnStartup })}
        />
        <Toggle
          label="Also restore what you typed into forms"
          hint="Off by default: this writes form contents — including a half-typed password — into the local database."
          checked={settings.restoreFormState}
          onChange={(restoreFormState) => update({ restoreFormState })}
        />
      </Group>

      <Group title="Privacy">
        <Toggle
          label="Record browsing history"
          hint="When off, nothing is written to the history list at all."
          checked={settings.recordHistory}
          onChange={(recordHistory) => update({ recordHistory })}
        />
        <Toggle
          label="Warn before opening executable downloads"
          hint="Based on the file extension alone. It cannot tell whether a particular file is harmful."
          checked={settings.warnOnExecutableDownload}
          onChange={(warnOnExecutableDownload) => update({ warnOnExecutableDownload })}
        />
        {/*
          Not a setting — a signpost. Private browsing lives entirely in the
          application menu, which is hidden behind Alt on Windows, so the feature
          was effectively undiscoverable from the one screen people open when
          they go looking for privacy controls.
        */}
        <p className="pt-1 text-xs text-[var(--color-text-muted)]">
          <span className="text-[var(--color-text-primary)]">Private window</span> — Ctrl+Shift+N, or
          File → New Private Window. It records no history, no browsing memory and no reopenable
          tabs, and is left out of session restore. It does not hide you from the sites you visit or
          from your network.
        </p>
      </Group>

      <Group title="Downloads">
        <Toggle
          label="Ask where to save each file"
          checked={settings.askWhereToSaveDownloads}
          onChange={(askWhereToSaveDownloads) => update({ askWhereToSaveDownloads })}
        />
      </Group>

      {/*
        Capabilities that genuinely are not built are listed as such rather than
        shown as controls, so nothing on this screen implies something the build
        cannot do.

        The reverse matters just as much: this group claimed private browsing did
        not exist for as long as private browsing existed, so the one place a
        user goes to check told them the feature was missing. A stale "not built"
        is as much a lie as an overstated capability.
      */}
      <Group title="Updates">
        <UpdateSection feedUrl={settings.updateFeedUrl} onFeedChange={update} />
      </Group>

      <Group title="Crash reports">
        <DiagnosticsSection />
      </Group>

      <Group title="Not built yet">
        <p className="text-xs text-[var(--color-text-muted)]">
          <span className="text-[var(--color-text-primary)]">Automatic updates.</span> This build
          cannot update itself, and it is not code-signed. Chromium ships security fixes roughly
          monthly, so check for a newer version yourself rather than assuming this one is current.
          Both need a signing certificate before they can exist — an unsigned update channel would be
          an unauthenticated way onto your machine, which is worse than none.
        </p>
      </Group>

        {/* Nothing matched: say so, rather than leaving an empty panel that
            looks like the settings failed to load. */}
        {filter.trim() !== '' && !Object.keys(GROUP_META).some((t) => groupMatches(t, filter)) && (
          <p className="text-xs text-[var(--color-text-muted)]">
            Nothing matches &ldquo;{filter.trim()}&rdquo;.
          </p>
        )}
        </div>
      </div>
     </SettingsCategory.Provider>
    </SettingsFilter.Provider>
  )
}

/** Kept in step with useAppearance's ACCENTS table. */
const ACCENT_SWATCHES: readonly [string, string][] = [
  ['default', '#6ea8fe'],
  ['blue', '#5b9dff'],
  ['green', '#4ade80'],
  ['purple', '#a78bfa'],
  ['amber', '#fbbf24'],
  ['rose', '#fb7185'],
  ['teal', '#2dd4bf']
]

/**
 * The current filter text, read by every Group.
 *
 * A context rather than a prop threaded through eleven call sites: the filter is
 * ambient to the whole panel, and passing it by hand would mean a new group
 * silently opting out of search by forgetting an argument.
 */
const SettingsFilter = createContext('')

/**
 * The category currently selected in the rail.
 *
 * A context for the same reason the filter is one: it is ambient to the whole
 * screen, and threading it through seventeen call sites would mean a new group
 * silently escaping the navigation by forgetting an argument.
 */
const SettingsCategory = createContext<Category>('Appearance')

/**
 * Extra words each group matches on, beyond its heading.
 *
 * Matching only headings would mean searching "zoom" or "cookies" found
 * nothing, because those words live in the controls rather than the titles.
 * Listed here rather than scraped from rendered children, which would depend on
 * how deeply a control happens to be nested — and kept in one table so the
 * groups and the "nothing matched" message can never disagree about what
 * matches.
 */
/**
 * Which category each group belongs to, and what it matches on in search.
 *
 * One table rather than two, so a group cannot end up in the navigation without
 * being findable, or findable without a home. The categories exist because
 * seventeen groups in a 380px scroll is not a settings screen, it is a list —
 * which is what made this the least usable part of the browser.
 */
const CATEGORIES = [
  'Appearance',
  'Search',
  'Privacy & security',
  'Browsing',
  'Extensions',
  'Earning',
  'About Slash'
] as const

type Category = (typeof CATEGORIES)[number]

const GROUP_META: Record<string, { category: Category; keywords: string }> = {
  Appearance: {
    category: 'Appearance',
    keywords: 'theme accent colour color density glass tabs vertical strip dark light'
  },
  'Start page': {
    category: 'Appearance',
    keywords: 'new tab home background image wallpaper gradient start page appearance'
  },
  Toolbar: {
    category: 'Appearance',
    keywords: 'toolbar buttons icons hide show customise customize clutter'
  },
  Search: {
    category: 'Search',
    keywords: 'engine google duckduckgo bing startpage keyword shortcut custom default'
  },
  Zoom: { category: 'Search', keywords: 'zoom per-site text size magnify scale percent' },
  'Content blocking': {
    category: 'Privacy & security',
    keywords: 'ads trackers shield popups youtube malicious scripts'
  },
  Privacy: {
    category: 'Privacy & security',
    keywords: 'cookies clear data private excluded origins'
  },
  'Saved sign-ins': {
    category: 'Privacy & security',
    keywords: 'password passwords login logins credentials autofill fill vault account'
  },
  'Restore points': { category: 'Browsing', keywords: 'session snapshot restore tabs startup' },
  'Browsing memory': {
    category: 'Browsing',
    keywords: 'index semantic embedding history pages search'
  },
  Downloads: { category: 'Browsing', keywords: 'folder location ask save' },
  Extensions: {
    category: 'Extensions',
    keywords: 'extension extensions addon add-on plugin unpacked crx chrome web store'
  },
  'Sponsored tiles': {
    category: 'Earning',
    keywords: 'sponsored ads advertising sponsor revenue tile support funding'
  },
  'Import from another browser': {
    category: 'About Slash',
    keywords: 'chrome edge bookmarks history migrate transfer'
  },
  Updates: { category: 'About Slash', keywords: 'version upgrade release' },
  'Crash reports': { category: 'About Slash', keywords: 'diagnostics minidump' },
  'Not built yet': { category: 'About Slash', keywords: 'roadmap missing planned' }
}

function groupMatches(title: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return `${title} ${GROUP_META[title]?.keywords ?? ''}`.toLowerCase().includes(q)
}

function Group({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element | null {
  const query = useContext(SettingsFilter)
  const category = useContext(SettingsCategory)

  // Searching looks across every category — someone typing "cookies" should not
  // have to already know which section it lives in. Only with an empty box does
  // the rail decide what is shown.
  if (query.trim() === '' && GROUP_META[title]?.category !== category) return null
  if (!groupMatches(title, query)) return null

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-sm">{label}</span>
      {children}
    </label>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled = false
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className={`flex gap-3 ${disabled ? 'opacity-45' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
      />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-[var(--color-text-muted)]">{hint}</span>}
      </span>
    </label>
  )
}
