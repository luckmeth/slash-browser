import type { Settings } from '@shared/types/settings'
import { SEARCH_ENGINES } from '@shared/constants'
import { useBrowserStore } from '../../stores/browserStore'

export function SettingsPanel(): React.JSX.Element {
  const settings = useBrowserStore((s) => s.settings)

  if (!settings) return <p className="p-4 text-sm text-[var(--color-text-muted)]">Loading…</p>

  const update = (patch: Partial<Settings>): void => {
    void window.browser.invoke('settings:update', patch)
  }

  return (
    <div className="space-y-6 p-4">
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

      <Group title="Search">
        <Field label="Search engine">
          <select
            value={settings.searchEngineId}
            onChange={(event) =>
              update({ searchEngineId: event.target.value as Settings['searchEngineId'] })
            }
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            {Object.entries(SEARCH_ENGINES).map(([id, engine]) => (
              <option key={id} value={id}>
                {engine.name}
              </option>
            ))}
          </select>
        </Field>
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
      */}
      <Group title="Not built yet">
        <Toggle
          label="Semantic search"
          checked={false}
          disabled
          hint="Keyword search works. Finding a page by a paraphrase needs a local embedding model, which is not installed."
          onChange={() => {}}
        />
        <Toggle
          label="Private browsing"
          checked={false}
          disabled
          hint="There is no private window yet. Memory already honours the setting for when there is."
          onChange={() => {}}
        />
        <p className="pt-1 text-xs text-[var(--color-text-muted)]">
          This build also has no automatic updates. Chromium ships security fixes regularly, so
          check for a newer version yourself rather than assuming this one is current.
        </p>
      </Group>
    </div>
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

function Group({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
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
