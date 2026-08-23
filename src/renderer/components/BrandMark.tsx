/**
 * The Slash mark, as inline SVG.
 *
 * Drawn rather than embedded as an image so it recolours with the surrounding
 * text, stays crisp at any size, and needs no CSP allowance for an external or
 * data-URI asset. That matters here because the mark appears on both light and
 * dark surfaces — onboarding, the start page, empty states — and a raster asset
 * would be right on one of them.
 *
 * Geometry matches `build/logo.svg`, which is what `npm run logo` rasterises
 * into the application icon. The two are separate files on purpose: the icon
 * carries its own dark rounded-square field, and this one is a bare glyph that
 * takes the colour of whatever it sits in. **Changing one means changing the
 * other**, or the icon on the taskbar stops matching the mark in the window.
 *
 * The mark is an S cut by a diagonal: two bowls, and a slash that separates
 * them and overshoots at both ends. The slash is drawn as its own stroke *and*
 * masked out of the S, so a dark hairline runs either side of it — that keyline
 * is what stops the two shapes reading as one blob at 16px.
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
          The gap is a *cut*, not an overlaid line: masking it out means the
          hairline shows whatever is behind the mark, so the mark works on any
          background rather than only on the one it was drawn against.
        */}
        <mask id="slash-cut">
          <rect width="64" height="64" fill="white" />
          <line x1="18.5" y1="55" x2="45.5" y2="9" stroke="black" strokeWidth="9.75" />
        </mask>
      </defs>

      <g mask="url(#slash-cut)">
        {/* Upper bowl: opens to the right, sweeping down and left. */}
        <path
          d="M 43.5 19.5 A 11.6 11.6 0 1 0 27.5 35.2"
          stroke="currentColor"
          strokeWidth="7.25"
          strokeLinecap="butt"
        />
        {/* Lower bowl: the same arc, rotated half a turn. */}
        <path
          d="M 20.5 44.5 A 11.6 11.6 0 1 0 36.5 28.8"
          stroke="currentColor"
          strokeWidth="7.25"
          strokeLinecap="butt"
        />
      </g>

      {/*
        The slash itself, narrower than the cut above so a hairline of
        background survives on each side. Overshooting the bowls at both ends is
        what makes it read as a slash through the letter rather than a join
        between the two halves.
      */}
      <line
        x1="20.5"
        y1="55.5"
        x2="43.5"
        y2="8.5"
        stroke="currentColor"
        strokeWidth="5.75"
        strokeLinecap="butt"
      />
    </svg>
  )
}
