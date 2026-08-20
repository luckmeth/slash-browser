import type { Settings } from '@shared/types/settings'

export type BackgroundId = Settings['newTabBackground']

/**
 * Start-page backdrops.
 *
 * CSS rather than photographs, deliberately. An image set large enough to look
 * good on a 4K display would add tens of megabytes to the installer for pure
 * decoration, and fetching one would turn opening a new tab into an outbound
 * request — which is the one thing this browser sells itself on not doing. A
 * gradient costs nothing, scales to any display, and never phones anywhere.
 *
 * Each is layered radial gradients over a base colour. They sit *behind* the
 * glass surfaces, so they are deliberately low-contrast: a backdrop that
 * competes with the content on top of it is a worse backdrop.
 */
export const BACKGROUNDS: Record<
  Exclude<BackgroundId, 'custom'>,
  { label: string; css: string }
> = {
  aurora: {
    label: 'Aurora',
    css:
      'radial-gradient(70rem 40rem at 15% -10%, rgba(94,234,212,0.16), transparent 60%),' +
      'radial-gradient(60rem 38rem at 85% 5%, rgba(129,140,248,0.18), transparent 62%),' +
      'radial-gradient(50rem 34rem at 50% 100%, rgba(56,189,248,0.12), transparent 65%)'
  },
  dusk: {
    label: 'Dusk',
    css:
      'radial-gradient(65rem 40rem at 80% -5%, rgba(244,114,182,0.16), transparent 60%),' +
      'radial-gradient(60rem 36rem at 10% 10%, rgba(129,140,248,0.16), transparent 62%),' +
      'radial-gradient(70rem 40rem at 50% 110%, rgba(251,146,60,0.10), transparent 60%)'
  },
  mesh: {
    label: 'Mesh',
    css:
      'radial-gradient(40rem 30rem at 20% 20%, rgba(56,189,248,0.16), transparent 55%),' +
      'radial-gradient(38rem 28rem at 75% 15%, rgba(168,85,247,0.14), transparent 55%),' +
      'radial-gradient(44rem 32rem at 60% 80%, rgba(34,197,94,0.10), transparent 58%),' +
      'radial-gradient(36rem 26rem at 15% 85%, rgba(251,191,36,0.10), transparent 55%)'
  },
  ember: {
    label: 'Ember',
    css:
      'radial-gradient(66rem 40rem at 50% -12%, rgba(251,146,60,0.16), transparent 60%),' +
      'radial-gradient(50rem 34rem at 12% 60%, rgba(239,68,68,0.10), transparent 60%),' +
      'radial-gradient(56rem 36rem at 88% 70%, rgba(217,119,6,0.10), transparent 60%)'
  },
  deep: {
    label: 'Deep',
    css:
      'radial-gradient(72rem 44rem at 50% -15%, rgba(59,130,246,0.14), transparent 62%),' +
      'radial-gradient(52rem 34rem at 85% 90%, rgba(30,64,175,0.16), transparent 60%)'
  },
  plain: {
    label: 'None',
    // Deliberately empty: some people want a flat surface, and on a low-end GPU
    // or Windows 10 (where the acrylic is ignored anyway) that is the faster
    // and more legible choice.
    css: ''
  }
}

/** The CSS `background-image` for the chosen backdrop. */
export function backgroundCss(
  id: BackgroundId,
  customDataUrl: string | null
): string | undefined {
  if (id === 'custom') return customDataUrl ? `url("${customDataUrl}")` : undefined
  const preset = BACKGROUNDS[id]
  return preset && preset.css !== '' ? preset.css : undefined
}
