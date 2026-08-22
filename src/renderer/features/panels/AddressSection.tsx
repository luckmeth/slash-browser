import { useCallback, useEffect, useState } from 'react'
import type { SavedAddressRecord } from '@shared/types/address'

const BLANK: SavedAddressRecord = {
  id: 0,
  label: '',
  name: '',
  givenName: '',
  familyName: '',
  organization: '',
  streetLine1: '',
  streetLine2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
  phone: '',
  email: ''
}

const FIELDS: { key: keyof SavedAddressRecord; label: string; span?: boolean }[] = [
  { key: 'label', label: 'Name for this address (e.g. Home)', span: true },
  { key: 'givenName', label: 'First name' },
  { key: 'familyName', label: 'Last name' },
  { key: 'organization', label: 'Company', span: true },
  { key: 'streetLine1', label: 'Street address', span: true },
  { key: 'streetLine2', label: 'Apartment, suite, unit', span: true },
  { key: 'city', label: 'Town or city' },
  { key: 'region', label: 'State, province or county' },
  { key: 'postalCode', label: 'Postcode' },
  { key: 'country', label: 'Country' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' }
]

/**
 * Saved addresses.
 *
 * Typed in here, never captured from a page — the same position the password
 * vault takes, and for the same reason: a preload that reads what you enter into
 * forms is a much larger change to what this browser is than saving a few
 * keystrokes justifies.
 */
export function AddressSection(): React.JSX.Element {
  const [addresses, setAddresses] = useState<SavedAddressRecord[]>([])
  const [editing, setEditing] = useState<SavedAddressRecord | null>(null)

  const load = useCallback((): void => {
    void window.browser.invoke('addresses:list', undefined).then((result) => {
      if (result.ok) setAddresses(result.value)
    })
  }, [])

  useEffect(load, [load])

  const save = (): void => {
    if (!editing) return
    const payload = editing.id === 0 ? { ...editing, id: undefined } : editing
    void window.browser.invoke('addresses:save', payload).then(() => {
      setEditing(null)
      load()
    })
  }

  return (
    <div>
      {addresses.length === 0 && !editing && (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Nothing saved yet. Add one and Slash will offer to fill it in when you right-click a
          delivery or checkout form.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        {addresses.map((address) => (
          <div
            key={address.id}
            className="flex items-start justify-between gap-2 rounded-lg border border-[var(--glass-edge)] px-2.5 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-xs">
                {address.label.trim() !== '' ? address.label : 'Saved address'}
              </p>
              <p className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">
                {[address.streetLine1, address.city, address.postalCode]
                  .filter((part) => part.trim() !== '')
                  .join(', ')}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={() => setEditing(address)}
                className="cursor-default rounded border border-[var(--glass-edge)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() =>
                  void window.browser.invoke('addresses:delete', { id: address.id }).then(load)
                }
                className="cursor-default rounded border border-[var(--glass-edge)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-warn)] hover:text-[var(--color-warn)]"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing ? (
        <div className="mt-2 rounded-lg border border-[var(--glass-edge)] p-2.5">
          <div className="grid grid-cols-2 gap-2">
            {FIELDS.map((field) => (
              <label
                key={field.key}
                className={field.span === true ? 'col-span-2 block' : 'block'}
              >
                <span className="mb-1 block text-[10px] text-[var(--color-text-muted)]">
                  {field.label}
                </span>
                <input
                  value={String(editing[field.key] ?? '')}
                  onChange={(event) =>
                    setEditing({ ...editing, [field.key]: event.target.value })
                  }
                  className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                />
              </label>
            ))}
          </div>
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={save}
              className="cursor-default rounded-md border border-[var(--color-accent)] px-2.5 py-1 text-xs text-[var(--color-accent)] transition"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="cursor-default rounded-md border border-[var(--glass-edge)] px-2.5 py-1 text-xs transition hover:border-[var(--color-accent)]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing({ ...BLANK })}
          className="mt-2 cursor-default rounded-md border border-[var(--glass-edge)] px-2.5 py-1 text-xs transition hover:border-[var(--color-accent)]"
        >
          Add an address
        </button>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Filling types the value in through the browser&rsquo;s own input pipeline, the same path a
        keystroke takes — it is never put into a script running in the page, and the page&rsquo;s
        own code never receives it from Slash.
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        There is no card storage here, deliberately. Keeping a card number means holding regulated
        data this project cannot protect better than a dedicated password manager already does, so
        Slash fills addresses and leaves cards alone rather than half-doing it.
      </p>
    </div>
  )
}
