import type { Settings } from '@shared/types/settings'
import { useBrowserStore } from '../../stores/browserStore'
import { BACKGROUNDS } from '../newtab/backgrounds'

type BackgroundId = Settings['newTabBackground']

/**
 * How the start page looks.
 *
 * The presets are CSS gradients, not photographs — see `backgrounds.ts` for why
 * that is a deliberate choice rather than a shortcut. A custom image is read
 * from disk and never fetched.
 */
export function NewTabSection(): React.JSX.Element {
  const settings = useBrowserStore((s) => s.settings)
  const current = settings?.newTabBackground ?? 'aurora'
  const customPath = settings?.newTabCustomBackground ?? ''

  const update = (patch: Partial<Settings>): void => {
    void window.browser.invoke('settings:update', patch)
  }

  return (
    <div>
      <div className="grid grid-cols-3 gap-1.5">
        {(Object.keys(BACKGROUNDS) as Exclude<BackgroundId, 'custom'>[]).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={current === id}
            onClick={() => update({ newTabBackground: id })}
            className={`h-12 cursor-default rounded-lg border text-[11px] transition ${
              current === id
                ? 'border-[var(--color-accent)]'
                : 'border-[var(--glass-edge)] hover:border-[var(--glass-edge-strong)]'
            }`}
            style={{
              // The swatch is the backdrop itself, over the surface colour, so
              // what you pick is what you get rather than a name for it.
              background:
                BACKGROUNDS[id].css === ''
                  ? 'var(--color-surface-raised)'
                  : `${BACKGROUNDS[id].css}, var(--color-surface-raised)`
            }}
          >
            {BACKGROUNDS[id].label}
          </button>
        ))}

        <button
          type="button"
          aria-pressed={current === 'custom'}
          onClick={() => void window.browser.invoke('newtab:pickBackground', undefined)}
          className={`h-12 cursor-default rounded-lg border text-[11px] transition ${
            current === 'custom'
              ? 'border-[var(--color-accent)]'
              : 'border-[var(--glass-edge)] hover:border-[var(--glass-edge-strong)]'
          }`}
        >
          Your image…
        </button>
      </div>

      {current === 'custom' && customPath !== '' && (
        <p className="mt-1.5 truncate text-[11px] text-[var(--color-text-muted)]" title={customPath}>
          {customPath}
        </p>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        The presets are drawn, not downloaded — they add nothing to the install size and never
        fetch anything. Your own image is read from disk and stays there.
      </p>
    </div>
  )
}
