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
        Features whose engines do not exist yet are shown as disabled rather than
        hidden, so the roadmap is visible and no control implies capability the
        build does not have.
      */}
      <Group title="Not yet available">
        <Toggle label="Index page content for search" checked={false} disabled hint="Phase 5 — Web Memory" onChange={() => {}} />
        <Toggle label="Semantic search" checked={false} disabled hint="Phase 5 — opt-in local model" onChange={() => {}} />
        <Toggle label="AI assistance" checked={false} disabled hint="Phase 7 — requires your own API key" onChange={() => {}} />
        <p className="pt-1 text-xs text-[var(--color-text-muted)]">
          Permission controls arrive in Phase 4. Until then this build denies every site permission
          request — camera, microphone, location and notifications will not work.
        </p>
      </Group>
    </div>
  )
}

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
