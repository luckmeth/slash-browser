'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MS_PER_HOUR, formatCents, quote, scheduleProblems, type Tier } from '@slash/ad-shared'
import { supabaseBrowser } from '@/lib/supabase/browser'
import { notifySubmitted } from '@/app/campaigns/new/actions'
import { ImageUpload, type Chosen } from './ImageUpload'
import { NewTabPreview } from './NewTabPreview'

/**
 * The campaign builder.
 *
 * The cost is computed with the same module the server prices from
 * (`@slash/ad-shared`), which is in turn mirrored by the database trigger that
 * has the final word. Three layers agreeing by construction rather than by
 * habit — a quote that differs from the charge is the fastest way to lose an
 * advertiser you just won.
 */

interface Props {
  tiers: (Tier & { description: string })[]
  minLeadHours: number
  currency: string
  advertiserAuthId: string
  /** Shown in the preview, where the reader would see it. */
  companyName: string
}

/** `datetime-local` gives wall-clock text; this reads it in the browser's own zone. */
const parseLocal = (value: string): number => (value === '' ? NaN : new Date(value).getTime())

/** A default start that is already past the lead time, rounded to the hour. */
function defaultStart(minLeadHours: number): string {
  const at = new Date(Date.now() + (minLeadHours + 1) * MS_PER_HOUR)
  at.setMinutes(0, 0, 0)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:00`
}

export function CampaignForm({
  tiers,
  minLeadHours,
  currency,
  advertiserAuthId,
  companyName
}: Props): React.JSX.Element {
  const router = useRouter()
  const [tierKey, setTierKey] = useState(tiers[0]?.placementTier ?? '')
  const tier = tiers.find((candidate) => candidate.placementTier === tierKey) ?? tiers[0]

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [link, setLink] = useState('')
  const [start, setStart] = useState(() => defaultStart(minLeadHours))
  const [hours, setHours] = useState(tier?.minHours ?? 24)
  const [image, setImage] = useState<Chosen | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')

  const booking = useMemo(() => {
    const startsAt = parseLocal(start)
    return { startsAt, endsAt: startsAt + hours * MS_PER_HOUR }
  }, [start, hours])

  const problems = useMemo(() => {
    if (!tier || Number.isNaN(booking.startsAt)) return []
    return scheduleProblems(tier, booking, Date.now(), minLeadHours)
  }, [tier, booking, minLeadHours])

  const price = tier && !Number.isNaN(booking.startsAt) ? quote(tier, booking) : null

  const linkProblem =
    link !== '' && !/^https:\/\/\S+\.\S+/i.test(link)
      ? 'The landing page must be an https:// address.'
      : ''

  const ready =
    tier !== undefined &&
    title.trim() !== '' &&
    link !== '' &&
    linkProblem === '' &&
    problems.length === 0 &&
    price !== null &&
    !busy

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!ready || !tier) return
    setBusy(true)
    setFailure('')

    try {
      const supabase = supabaseBrowser()

      // Uploaded first. A campaign row pointing at an image that failed to
      // upload is a campaign that will be silently dropped from every batch,
      // and the advertiser would already have paid by then.
      let imagePath: string | null = null
      if (image) {
        const extension = image.file.name.split('.').pop()?.toLowerCase() ?? 'png'
        // The folder must be the uploader's auth id — that prefix is what the
        // storage policy checks, and it is what stops one advertiser writing
        // over another's approved creative.
        imagePath = `${advertiserAuthId}/${crypto.randomUUID()}.${extension}`
        const { error } = await supabase.storage
          .from('campaign-assets')
          .upload(imagePath, image.file, { contentType: image.file.type, upsert: false })
        if (error) throw new Error(`The image could not be uploaded: ${error.message}`)
      }

      // No price is sent. The database computes it from the tier and the window
      // and ignores anything a client claims — see campaigns_apply_pricing.
      const { data, error } = await supabase
        .from('campaigns')
        .insert({
          title: title.trim(),
          description: description.trim(),
          destination_link: link.trim(),
          image_path: imagePath,
          placement_tier: tier.placementTier,
          starts_at: new Date(booking.startsAt).toISOString(),
          ends_at: new Date(booking.endsAt).toISOString()
        })
        .select('id')
        .single()

      if (error) throw new Error(error.message)

      // Submitted for review, not for payment. Nobody is charged until a person
      // has approved it, which is why there is no checkout redirect here.
      await notifySubmitted(data.id)
      router.push('/dashboard?submitted=1')
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Something went wrong.')
      setBusy(false)
    }
  }

  if (!tier) {
    return (
      <div className="card">
        <p className="note" style={{ margin: 0 }}>
          No placements are on sale at the moment.
        </p>
      </div>
    )
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div>
        <label htmlFor="tier">Placement</label>
        <select id="tier" value={tierKey} onChange={(event) => setTierKey(event.target.value)}>
          {tiers.map((candidate) => (
            <option key={candidate.placementTier} value={candidate.placementTier}>
              {candidate.displayName} — {formatCents(candidate.hourlyRateCents, currency)}/hour
            </option>
          ))}
        </select>
        <p className="note">{tier.description}</p>
      </div>

      <div>
        <label htmlFor="title">Headline</label>
        <input
          id="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          required
          placeholder="What you want people to read first"
        />
      </div>

      <div>
        <label htmlFor="description">Supporting line (optional)</label>
        <textarea
          id="description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={400}
        />
      </div>

      <div>
        <label htmlFor="link">Landing page</label>
        <input
          id="link"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder="https://example.com/offer"
          required
        />
        {linkProblem !== '' && <p className="error">{linkProblem}</p>}
        <p className="note">
          Must be https. Readers go straight there — the click is not routed through us, so there is
          no redirect collecting anything on the way.
        </p>
      </div>

      {/*
        The advert, as it will actually appear, updating as they type. Somebody
        about to spend money on a placement should be able to see it rather than
        imagine it — and it catches a headline that is too long to fit long
        before an operator has to reject it for that.
      */}
      <div>
        <label>Preview</label>
        <NewTabPreview
          chromeless
          headline={title.trim() === '' ? 'Your headline here' : title}
          body={description}
          sponsor={companyName}
          image={image?.previewUrl ?? null}
        />
      </div>

      <ImageUpload value={image} onChange={setImage} />

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 220px' }}>
          <label htmlFor="start">Starts</label>
          <input
            id="start"
            type="datetime-local"
            value={start}
            step={3600}
            onChange={(event) => setStart(event.target.value)}
            required
          />
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <label htmlFor="hours">Hours</label>
          <input
            id="hours"
            type="number"
            min={tier.minHours}
            step={1}
            value={hours}
            onChange={(event) => setHours(Math.max(1, Math.round(Number(event.target.value) || 0)))}
            required
          />
        </div>
      </div>

      {problems.map((problem) => (
        <p className="error" key={problem.code}>
          {problem.message}
        </p>
      ))}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="note">Total</div>
            <div className="hero-cost">
              {price ? formatCents(price.totalCents, currency) : '—'}
            </div>
          </div>
          <div className="note" style={{ textAlign: 'right' }}>
            {price ? `${price.hours} hours` : 'Pick a valid window'}
            <br />
            {formatCents(tier.hourlyRateCents, currency)} per hour
            <br />
            {!Number.isNaN(booking.endsAt) && price
              ? `Ends ${new Date(booking.endsAt).toLocaleString()}`
              : ''}
          </div>
        </div>
      </div>

      {failure !== '' && <p className="error">{failure}</p>}

      <div>
        <button type="submit" disabled={!ready}>
          {busy ? 'Submitting…' : 'Submit for review'}
        </button>
        <p className="note" style={{ marginTop: 10 }}>
          A person reads every campaign before it runs. <strong>You are not charged now</strong> —
          once it is approved you will be emailed, and you pay then. Nothing is taken for something
          we turn down.
        </p>
      </div>
    </form>
  )
}
