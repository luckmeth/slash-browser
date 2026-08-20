import { useBrowserStore } from '../../stores/browserStore'

/**
 * Which toolbar buttons are shown.
 *
 * Stored as a deny-list, so a button added in a later version appears by
 * default rather than being invisible to everyone who ever customised their
 * toolbar. Hiding a button never removes the feature — its keyboard shortcut
 * and menu entry keep working — which is why this is worded as showing and
 * hiding rather than enabling and disabling.
 */
const BUTTONS: readonly { id: string; label: string; shortcut: string }[] = [
  { id: 'external', label: 'Open in default browser', shortcut: '' },
  { id: 'reading', label: 'Reading list', shortcut: 'Ctrl+Shift+D saves' },
  { id: 'bookmarks', label: 'Bookmarks', shortcut: 'Ctrl+Shift+O' },
  { id: 'history', label: 'History', shortcut: 'Ctrl+H' },
  { id: 'downloads', label: 'Downloads', shortcut: 'Ctrl+J' },
  { id: 'performance', label: 'Performance', shortcut: 'Ctrl+Shift+P' }
]

export function ToolbarSection(): React.JSX.Element {
  const settings = useBrowserStore((s) => s.settings)
  const hidden = settings?.hiddenToolbarButtons ?? []

  const toggle = (id: string, show: boolean): void => {
    const next = show ? hidden.filter((h) => h !== id) : [...new Set([...hidden, id])]
    void window.browser.invoke('settings:update', { hiddenToolbarButtons: next })
  }

  return (
    <div>
      <ul className="flex flex-col gap-1">
        {BUTTONS.map((button) => (
          <li key={button.id}>
            <label className="flex cursor-default items-center gap-2 rounded-md px-1 py-1 transition hover:bg-white/[0.06]">
              <input
                type="checkbox"
                checked={!hidden.includes(button.id)}
                onChange={(event) => toggle(button.id, event.target.checked)}
              />
              <span className="min-w-0 flex-1 truncate text-[13px]">{button.label}</span>
              {button.shortcut && (
                <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
                  {button.shortcut}
                </span>
              )}
            </label>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Hiding a button only removes it from the toolbar. Its keyboard shortcut and its menu entry
        keep working. Settings cannot be hidden, since it is the way back here.
      </p>
    </div>
  )
}
