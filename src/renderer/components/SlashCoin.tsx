import { useState } from 'react'

/**
 * The coin.
 *
 * Renders a supplied coin render when one has been placed in the repository,
 * and falls back to the CSS disc that has always been here when it has not.
 *
 * **Why a glob rather than a plain import.** `import coinUrl from
 * '../assets/coin.png'` is resolved at build time: with no file there, the
 * *build fails*. That is the wrong failure for an optional brand asset — the
 * browser should compile and run whether or not somebody has dropped an image
 * in yet. `import.meta.glob` resolves statically to an empty object when
 * nothing matches, so the asset is genuinely optional and adding it later is a
 * file copy rather than a code change.
 *
 * This is the **first bitmap in the renderer**; everything else here is inline
 * SVG, and `BrandMark` explains why — a drawn mark recolours with its
 * surroundings and needs no CSP allowance. The exception is deliberate: this is
 * an illustration of an object, not a mark, and a photoreal coin is not
 * something to reproduce in paths. It is still worth redrawing as SVG one day,
 * which is a filename change here and nothing else.
 */
const found = import.meta.glob('../assets/coin.{png,webp,jpg,svg}', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

const coinUrl: string | undefined = Object.values(found)[0]

export function SlashCoin({
  size = 68,
  className = ''
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  // An asset that 404s at runtime — a broken emit, a stripped resource — must
  // not leave a hole where the product's own symbol should be.
  const [broken, setBroken] = useState(false)

  if (coinUrl !== undefined && !broken) {
    return (
      <img
        src={coinUrl}
        alt=""
        aria-hidden="true"
        decoding="async"
        // Explicit dimensions so the layout does not shift when it decodes.
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={`slash-coin-img slash-coin-bob ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <div
      aria-hidden="true"
      className={`slash-coin slash-coin-bob grid place-items-center font-bold text-black/70 ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      S
    </div>
  )
}
