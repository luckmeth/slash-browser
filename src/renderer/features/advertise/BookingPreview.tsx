import { placementShapeFor } from '@shared/placements'
import { PlacementPreview } from '../newtab/PlacementPreview'

/**
 * What the advertiser is about to buy, drawn as they will see it.
 *
 * A booking form that asks for a headline, a link and an image and then shows
 * none of them back is asking somebody to spend money on faith. This renders the
 * creative in the shape the selected tier actually lands in, beside a mock of
 * the whole page showing *where* on it that shape sits — the two halves of the
 * question "what am I getting".
 *
 * **What it deliberately is not:** the production sponsored components. Those
 * own impression counting, dismissal, the `sponsor:changed` subscription and the
 * width guard that stops a rail billing for an impression nobody saw. Mounting
 * one here to preview an unsubmitted campaign would fire an impression against a
 * creative that does not exist. This is markup only, fires no IPC, and counts
 * nothing.
 *
 * The cost of that choice, stated plainly: this is a *likeness*, not the same
 * component, so the two can drift. It is kept close by using the same tokens,
 * radii and label rules, and by being small enough to compare by eye.
 */
export function BookingPreview({
  title,
  description,
  imageBase64,
  imageType,
  sponsor,
  placementTier
}: {
  title: string
  description: string
  imageBase64: string
  imageType: string
  sponsor: string
  placementTier: string
}): React.JSX.Element {
  const shape = placementShapeFor(placementTier)
  const image = imageBase64 !== '' ? `data:${imageType};base64,${imageBase64}` : ''
  // Placeholders, so an empty form previews as a shape rather than as nothing.
  // Never presented as the advertiser's own words — the moment they type, their
  // text replaces this.
  const headline = title.trim() !== '' ? title : 'Your headline goes here'
  const body = description.trim() !== '' ? description : 'A supporting line, if you want one.'
  const name = sponsor.trim() !== '' ? sponsor : 'Your company'

  return (
    <div className="mt-4 rounded-xl border border-[var(--glass-edge)] bg-white/[0.03] p-4">
      <p className="text-[11px] tracking-[0.14em] text-[var(--color-text-muted)] uppercase">
        How it will look
      </p>

      <div className="mt-3 grid gap-4 sm:grid-cols-[1fr_150px]">
        <div className="min-w-0">
          {shape === 'background' ? (
            <BackgroundLikeness image={image} headline={headline} body={body} name={name} />
          ) : shape === 'banner' ? (
            <BannerLikeness image={image} headline={headline} body={body} name={name} />
          ) : (
            <TileLikeness image={image} headline={headline} body={body} name={name} />
          )}
        </div>

        {/* Where on the page that shape lands. Pure CSS, nothing fetched. */}
        <div className="flex flex-col items-center gap-2">
          <PlacementPreview placement={shape} />
          <span className="text-[10px] text-[var(--color-text-muted)]">on the start page</span>
        </div>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Every placement carries the word <strong>Sponsored</strong> and your company name. That is
        not a setting, and it is why readers trust the ones that run here.
      </p>
    </div>
  )
}

/** The label every placement carries. Not optional, anywhere. */
function SponsoredLabel({ name }: { name: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
      <span className="rounded bg-white/10 px-1.5 py-0.5 tracking-[0.08em] uppercase">
        Sponsored
      </span>
      <span className="truncate">{name}</span>
    </span>
  )
}

function TileLikeness({
  image,
  headline,
  body,
  name
}: {
  image: string
  headline: string
  body: string
  name: string
}): React.JSX.Element {
  return (
    <div className="glass-raised flex items-center gap-3 rounded-2xl border border-[var(--glass-edge)] p-3">
      <span
        className="size-12 shrink-0 rounded-lg bg-white/5 bg-cover bg-center"
        style={image !== '' ? { backgroundImage: `url(${image})` } : undefined}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{headline}</span>
        <span className="mt-0.5 block truncate text-[11.5px] text-[var(--color-text-muted)]">
          {body}
        </span>
        <span className="mt-1 block">
          <SponsoredLabel name={name} />
        </span>
      </span>
    </div>
  )
}

function BannerLikeness({
  image,
  headline,
  body,
  name
}: {
  image: string
  headline: string
  body: string
  name: string
}): React.JSX.Element {
  return (
    <div
      className="relative flex min-h-[120px] flex-col justify-end overflow-hidden rounded-2xl border border-[var(--glass-edge)] bg-white/5 bg-cover bg-center p-4"
      style={image !== '' ? { backgroundImage: `url(${image})` } : undefined}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: 'linear-gradient(90deg, rgba(8,10,16,0.88), rgba(8,10,16,0.25))' }}
      />
      <span className="relative">
        <span className="block truncate text-[15px] font-semibold">{headline}</span>
        <span className="mt-0.5 block truncate text-[12px] text-[var(--color-text-muted)]">
          {body}
        </span>
        <span className="mt-1.5 block">
          <SponsoredLabel name={name} />
        </span>
      </span>
    </div>
  )
}

function BackgroundLikeness({
  image,
  headline,
  body,
  name
}: {
  image: string
  headline: string
  body: string
  name: string
}): React.JSX.Element {
  return (
    <div
      className="relative flex min-h-[150px] flex-col items-center justify-center overflow-hidden rounded-2xl border border-[var(--glass-edge)] bg-white/5 bg-cover bg-center p-4 text-center"
      style={image !== '' ? { backgroundImage: `url(${image})` } : undefined}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: 'linear-gradient(180deg, rgba(8,10,16,0.45), rgba(8,10,16,0.8))' }}
      />
      <span className="relative">
        <span className="block text-[16px] font-semibold">{headline}</span>
        <span className="mt-1 block text-[12px] text-[var(--color-text-muted)]">{body}</span>
        <span className="mt-2 flex justify-center">
          <SponsoredLabel name={name} />
        </span>
      </span>
    </div>
  )
}
