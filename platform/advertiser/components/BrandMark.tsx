/**
 * The Slash mark, as inline SVG.
 *
 * The same geometry the browser draws, deliberately — an advertiser arriving
 * here should recognise the product they are buying into, and a site selling
 * placement in a browser with no sign of that browser's identity looks like a
 * phishing page.
 *
 * Drawn rather than embedded so it recolours with the surrounding text, stays
 * crisp at any size, and needs no image asset to load.
 */
export function BrandMark({
  size = 28,
  className = ''
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  // Unique per instance: two marks on one page would otherwise share a mask id,
  // and the second would silently render without its slash.
  const maskId = `slash-cut-${size}`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        {/*
          The slash is a *cut*, not an overlaid line: masking it out means the
          gap shows whatever is behind the mark, so it works on any background.
        */}
        <mask id={maskId}>
          <rect width="64" height="64" fill="white" />
          <line x1="16.5" y1="53.8" x2="47.5" y2="10.3" stroke="black" strokeWidth="3.8" />
        </mask>
      </defs>

      <g mask={`url(#${maskId})`} transform="rotate(-10 32 32)">
        <path
          d="M 41.87 20.66 A 10.5 10.5 0 1 0 29.28 34.39"
          stroke="currentColor"
          strokeWidth="6.5"
          strokeLinecap="butt"
        />
        <path
          d="M 22.13 43.84 A 10.5 10.5 0 1 0 34.72 30.11"
          stroke="currentColor"
          strokeWidth="6.5"
          strokeLinecap="butt"
        />
      </g>
    </svg>
  )
}
