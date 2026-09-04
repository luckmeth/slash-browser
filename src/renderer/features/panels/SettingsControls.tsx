import { useId, useState } from 'react'
import { splitHint } from './settingsText'

/**
 * The controls a settings row is built from.
 *
 * Extracted so every screen uses the same ones. `SponsorSection` had its own
 * raw checkboxes and therefore missed the settings redesign entirely — it was
 * the one screen still showing square boxes next to pill switches, which reads
 * as two different applications rather than two sections of one.
 *
 * `SettingsPanel` imports these rather than the other way round: it already
 * imports `SponsorSection`, so exporting from there would be a cycle.
 */

/**
 * One line of explanation, with the rest a click away.
 *
 * The long version is kept — several of these settings have real costs that
 * ought to be stated — but leading with all of it made the screen unreadable.
 * See `splitHint`.
 */
export function HintText({ lead, rest }: { lead: string; rest: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <span className="mb-1.5 block text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
      {open ? `${lead} ${rest}` : lead}
      {rest !== '' && (
        <button
          type="button"
          onClick={(event) => {
            // Inside a <label>, so a click would otherwise toggle the control.
            event.preventDefault()
            event.stopPropagation()
            setOpen((was) => !was)
          }}
          className="ml-1.5 cursor-pointer rounded text-[var(--color-accent)] hover:underline"
        >
          {open ? 'Less' : 'More'}
        </button>
      )}
    </span>
  )
}

/**
 * A pill switch.
 *
 * Still a real checkbox underneath — `sr-only` rather than replaced — so it
 * keeps its keyboard behaviour, its focus ring and its announcement to a screen
 * reader. A div with an onClick would look identical and be unusable without a
 * mouse.
 */
export function Switch({
  id,
  checked,
  disabled,
  onChange
}: {
  id?: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <span className="relative mt-0.5 shrink-0">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`block h-[22px] w-[38px] rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-accent)] peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-transparent ${
          checked ? 'bg-[var(--color-accent)]' : 'bg-white/15'
        }`}
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-[3px] left-[3px] size-4 rounded-full bg-white shadow transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </span>
  )
}

export function Toggle({
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
  const { lead, rest } = splitHint(hint)
  // Associated by id rather than by nesting, and that is not a style
  // preference. `<button>` is a **labelable element**, so the "More" disclosure
  // inside this row became the label's implicit control — clicking the row
  // toggled the disclosure instead of the setting.
  const id = useId()
  return (
    <label
      htmlFor={id}
      className={`flex items-start justify-between gap-4 px-3.5 py-3 transition-colors ${
        disabled ? 'opacity-45' : 'cursor-pointer hover:bg-white/[0.03]'
      }`}
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-[var(--color-text-primary)]">
          {label}
        </span>
        {lead !== '' && <HintText lead={lead} rest={rest} />}
      </span>
      <Switch id={id} checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  )
}
