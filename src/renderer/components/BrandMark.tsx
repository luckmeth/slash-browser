/**
 * The Slash mark, as inline SVG.
 *
 * Drawn rather than embedded as an image so it recolours with the surrounding
 * text, stays crisp at any size, and needs no CSP allowance for an external or
 * data-URI asset.
 *
 * Geometry matches `build/icon.png`: two arcs forming an S, italicised slightly,
 * with a diagonal cut separating the bowls — the "slash".
 */
export function BrandMark({
  size = 64,
  className = ''
}: {
  size?: number
  className?: string
}): React.JSX.Element {
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
        <mask id="slash-cut">
          <rect width="64" height="64" fill="white" />
          <line x1="16.5" y1="53.8" x2="47.5" y2="10.3" stroke="black" strokeWidth="3.8" />
        </mask>
      </defs>

      <g mask="url(#slash-cut)" transform="rotate(-10 32 32)">
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
