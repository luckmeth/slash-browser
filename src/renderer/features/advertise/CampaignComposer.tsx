import { useEffect, useMemo, useState } from 'react'
import { checkCampaign, estimateCost } from '@shared/campaignRules'
import { countryOptions } from '@shared/countries'
import {
  type AdvertiserState,
  type CampaignInput,
  type CompanyInput
} from '@shared/types/advertising'
import { Icon } from '../../components/Icon'
import { CreativePicker } from './CreativePicker'

/**
 * Booking an advert without leaving the browser.
 *
 * Three steps, and the screen only ever shows the one you are on: sign in,
 * say who you are, book the run. The account is the **same Google sign-in as
 * Slash Coin** — one `auth.users` row, so somebody who already collects coins
 * is already signed in here.
 *
 * The two honest edges, stated on the screen rather than discovered:
 *
 * - **The price shown is an estimate.** The database applies the rate from its
 *   own card with a trigger, because a price arriving from a browser is a
 *   price somebody can edit. The estimator here exists so the figure moves as
 *   the dates do, and it is tested against the same arithmetic.
 * - **Payment happens on the web.** Card details are not typed into this
 *   window. An approved campaign is paid for through the portal, which opens
 *   in a tab, with Stripe on its own domain doing what it does everywhere.
 */
export function CampaignComposer(): React.JSX.Element {
  const [state, setState] = useState<AdvertiserState | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [done, setDone] = useState('')

  const load = (): void => {
    void window.browser.invoke('advertiser:state', undefined).then((result) => {
      if (result.ok) setState(result.value)
    })
  }
  useEffect(load, [])

  if (!state) return <></>

  if (!state.signedIn) {
    return (
      <section className="glass-raised rounded-2xl border border-[var(--glass-edge)] p-6 text-center">
        <h2 className="text-[16px] font-semibold">Advertise from here</h2>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-[var(--color-text-muted)]">
          Sign in with the same Google account you use for Slash Coin — it is one account, and there
          is no second sign-up. You will be able to fill in your company once and book runs from
          this page.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void window.browser.invoke('rewards:signIn', undefined).then((result) => {
              setBusy(false)
              if (result.ok && result.value.url !== '') {
                void window.browser.invoke('tabs:create', {
                  url: result.value.url,
                  background: false
                })
              }
            })
          }}
          className="mt-5 cursor-default rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-[13px] font-semibold text-black transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? 'Opening…' : 'Sign in to advertise'}
        </button>
      </section>
    )
  }

  return (
    <div className="space-y-3">
      <CompanyCard state={state} onSaved={load} />
      {state.company?.complete && (
        <BookingCard
          state={state}
          busy={busy}
          setBusy={setBusy}
          problem={problem}
          setProblem={setProblem}
          done={done}
          setDone={setDone}
          onSubmitted={load}
        />
      )}
      {state.campaigns.length > 0 && <CampaignList state={state} />}
    </div>
  )
}

function CompanyCard({
  state,
  onSaved
}: {
  state: AdvertiserState
  onSaved: () => void
}): React.JSX.Element {
  const company = state.company
  const [open, setOpen] = useState(!company?.complete)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState('')
  const [form, setForm] = useState<CompanyInput>({
    companyName: company?.companyName ?? '',
    contactEmail: company?.contactEmail ?? state.email,
    website: company?.website ?? '',
    description: company?.description ?? '',
    contactName: company?.contactName ?? '',
    contactPhone: company?.contactPhone ?? '',
    addressLine1: company?.addressLine1 ?? '',
    city: company?.city ?? '',
    postcode: company?.postcode ?? '',
    country: company?.country ?? '',
    taxId: company?.taxId ?? ''
  })

  const countries = useMemo(() => countryOptions(), [])
  const set = (field: keyof CompanyInput, value: string): void =>
    setForm({ ...form, [field]: value })

  return (
    <section className="glass-raised overflow-hidden rounded-2xl border border-[var(--glass-edge)]">
      <button
        type="button"
        onClick={() => setOpen(company?.complete ? !open : true)}
        className="flex w-full cursor-default items-center gap-3 px-5 py-4 text-left transition hover:bg-white/[0.03]"
      >
        <Icon name={company?.complete ? 'star' : 'warning'} size={15} />
        <span className="flex-1">
          <span className="block text-[13.5px] font-medium">Your company</span>
          <span className="block text-[12px] text-[var(--color-text-muted)]">
            {company?.complete
              ? `${company.companyName} — shown beside your adverts`
              : 'Needed before a campaign can be submitted. Filled in once.'}
          </span>
        </span>
        <Icon name="expand" size={14} className={open ? 'rotate-180 transition' : 'transition'} />
      </button>

      {open && (
        <div className="border-t border-[var(--glass-edge)] px-5 py-5">
          <p className="mb-4 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            The name and website are shown to readers — every placement in Slash is labelled with
            who paid for it. The rest is for invoices and for reaching you about a campaign, and
            appears nowhere public.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company name">
              <Input value={form.companyName} onChange={(v) => set('companyName', v)} />
            </Field>
            <Field label="Website (https)">
              <Input
                value={form.website}
                onChange={(v) => set('website', v)}
                placeholder="https://example.com"
              />
            </Field>
          </div>

          <Field label="What you do">
            <Input
              value={form.description}
              onChange={(v) => set('description', v)}
              placeholder="A sentence for whoever reviews your campaigns"
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Contact name">
              <Input value={form.contactName} onChange={(v) => set('contactName', v)} />
            </Field>
            <Field label="Contact email">
              <Input value={form.contactEmail} onChange={(v) => set('contactEmail', v)} />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Phone">
              <Input value={form.contactPhone} onChange={(v) => set('contactPhone', v)} />
            </Field>
            <Field label="Address">
              <Input value={form.addressLine1} onChange={(v) => set('addressLine1', v)} />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Town or city">
              <Input value={form.city} onChange={(v) => set('city', v)} />
            </Field>
            <Field label="Postcode">
              <Input value={form.postcode} onChange={(v) => set('postcode', v)} />
            </Field>
            <Field label="Country">
              <Select value={form.country} onChange={(v) => set('country', v)}>
                <option value="">Choose</option>
                {countries.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="VAT or company number (optional)">
            <Input value={form.taxId} onChange={(v) => set('taxId', v)} />
          </Field>

          {problem !== '' && <p className="mt-3 text-[12px] text-[var(--color-bad)]">{problem}</p>}

          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true)
              setProblem('')
              void window.browser.invoke('advertiser:saveCompany', form).then((result) => {
                setSaving(false)
                if (!result.ok) {
                  setProblem('Could not reach the advertising service.')
                  return
                }
                if (!result.value.ok) {
                  setProblem(result.value.problem)
                  return
                }
                setOpen(false)
                onSaved()
              })
            }}
            className="mt-5 cursor-default rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-[13px] font-semibold text-black transition hover:brightness-110 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save company'}
          </button>
        </div>
      )}
    </section>
  )
}

function BookingCard({
  state,
  busy,
  setBusy,
  problem,
  setProblem,
  done,
  setDone,
  onSubmitted
}: {
  state: AdvertiserState
  busy: boolean
  setBusy: (value: boolean) => void
  problem: string
  setProblem: (value: string) => void
  done: string
  setDone: (value: string) => void
  onSubmitted: () => void
}): React.JSX.Element {
  const [form, setForm] = useState<CampaignInput>({
    title: '',
    description: '',
    destinationLink: '',
    placementTier: state.rates[0]?.placementTier ?? '',
    startsAt: '',
    endsAt: '',
    imageBase64: '',
    imageType: ''
  })

  const problems = useMemo(
    () => checkCampaign(form, state.rates, 12, Date.now()),
    [form, state.rates]
  )
  const cost = estimateCost(form, state.rates)
  const rate = state.rates.find((entry) => entry.placementTier === form.placementTier)
  const problemFor = (field: string): string | undefined =>
    problems.find((entry) => entry.field === field)?.problem

  const set = (field: keyof CampaignInput, value: string): void => {
    setDone('')
    setProblem('')
    setForm({ ...form, [field]: value })
  }

  return (
    <section className="glass-raised rounded-2xl border border-[var(--glass-edge)] p-5">
      <h2 className="text-[14px] font-semibold">Book a run</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
        Somebody reads every campaign before it runs, and you are not charged until it is approved —
        so there is never money sitting with us for something we then turn down.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Title" problem={problemFor('title')}>
          <Input value={form.title} onChange={(v) => set('title', v)} />
        </Field>
        <Field label="Link (https)" problem={problemFor('destinationLink')}>
          <Input
            value={form.destinationLink}
            onChange={(v) => set('destinationLink', v)}
            placeholder="https://example.com/offer"
          />
        </Field>
      </div>

      <Field label="Description shown with the advert" problem={problemFor('description')}>
        <Input value={form.description} onChange={(v) => set('description', v)} />
      </Field>

      <Field label="Placement" problem={problemFor('placementTier')}>
        <Select value={form.placementTier} onChange={(v) => set('placementTier', v)}>
          {state.rates.map((entry) => (
            <option key={entry.placementTier} value={entry.placementTier}>
              {entry.displayName} — ${entry.hourlyRate.toFixed(2)} an hour, {entry.minHours}h
              minimum
            </option>
          ))}
        </Select>
      </Field>
      {rate && <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">{rate.description}</p>}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Starts" problem={problemFor('startsAt')}>
          <Input
            type="datetime-local"
            step={3600}
            value={form.startsAt}
            onChange={(v) => set('startsAt', v)}
          />
        </Field>
        <Field label="Ends" problem={problemFor('endsAt')}>
          <Input
            type="datetime-local"
            step={3600}
            value={form.endsAt}
            onChange={(v) => set('endsAt', v)}
          />
        </Field>
      </div>

      <CreativePicker
        imageType={form.imageType}
        problem={problemFor('image')}
        onPick={(base64, type) => {
          setDone('')
          setProblem('')
          setForm({ ...form, imageBase64: base64, imageType: type })
        }}
        onClear={() => setForm({ ...form, imageBase64: '', imageType: '' })}
      />

      {/* The estimate, beside the thing that changes it. */}
      <div className="mt-4 flex items-center justify-between rounded-xl border border-[var(--glass-edge)] bg-white/[0.03] px-4 py-3">
        <div>
          <p className="text-[11px] tracking-[0.14em] text-[var(--color-text-muted)] uppercase">
            Estimated cost
          </p>
          <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
            {cost.hours > 0
              ? `${cost.hours} hours at $${cost.hourlyRate.toFixed(2)}`
              : 'Choose a window to see the price'}
          </p>
        </div>
        <p className="text-[24px] font-semibold tabular-nums">${cost.total.toFixed(2)}</p>
      </div>
      <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
        The charged price is set by the server from its own rate card, not by this window. They
        agree; this is the figure you will be asked to pay.
      </p>

      {problem !== '' && <p className="mt-3 text-[12px] text-[var(--color-bad)]">{problem}</p>}
      {done !== '' && <p className="mt-3 text-[12px] text-[var(--color-good)]">{done}</p>}

      <button
        type="button"
        disabled={busy || problems.length > 0}
        onClick={() => {
          setBusy(true)
          setProblem('')
          void window.browser.invoke('advertiser:submitCampaign', form).then((result) => {
            setBusy(false)
            if (!result.ok) {
              setProblem('Could not reach the advertising service.')
              return
            }
            if (!result.value.ok) {
              setProblem(result.value.problem)
              return
            }
            setDone(
              'Submitted for review. You will hear either way, and you have not been charged.'
            )
            setForm({
              ...form,
              title: '',
              description: '',
              destinationLink: '',
              imageBase64: '',
              imageType: ''
            })
            onSubmitted()
          })
        }}
        className="mt-4 cursor-default rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-[13px] font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Submitting…' : 'Submit for review'}
      </button>
      {problems.length > 0 && (
        <span className="ml-3 text-[12px] text-[var(--color-text-muted)]">
          {problems.length} {problems.length === 1 ? 'field needs' : 'fields need'} attention
        </span>
      )}
    </section>
  )
}

function CampaignList({ state }: { state: AdvertiserState }): React.JSX.Element {
  return (
    <section className="glass-raised rounded-2xl border border-[var(--glass-edge)] p-5">
      <h2 className="text-[14px] font-semibold">Your campaigns</h2>
      <div className="mt-3 space-y-2">
        {state.campaigns.map((campaign) => (
          <div
            key={campaign.id}
            className="flex items-center gap-3 rounded-xl border border-[var(--glass-edge)] px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px]">{campaign.title}</p>
              <p className="text-[11.5px] text-[var(--color-text-muted)]">
                {new Date(campaign.startsAt).toLocaleDateString()} —{' '}
                {new Date(campaign.endsAt).toLocaleDateString()} · ${campaign.totalCost.toFixed(2)}
              </p>
              {campaign.reviewNote !== '' && (
                <p className="mt-1 text-[11.5px] text-[var(--color-warn)]">{campaign.reviewNote}</p>
              )}
            </div>
            <span className="shrink-0 rounded-full bg-white/8 px-2.5 py-1 text-[11px] text-[var(--color-text-muted)]">
              {campaign.status.replace(/_/g, ' ')}
            </span>
            {/* Paying means Stripe, and Stripe means the web. */}
            {campaign.status === 'approved_unpaid' || campaign.status === 'pending_payment' ? (
              <button
                type="button"
                disabled={state.portalUrl === ''}
                onClick={() =>
                  void window.browser.invoke('tabs:create', {
                    url: `${state.portalUrl.replace(/\/+$/, '')}/dashboard`,
                    background: false
                  })
                }
                className="shrink-0 cursor-default rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[11.5px] font-semibold text-black disabled:opacity-40"
              >
                Pay
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] text-[var(--color-text-muted)]">
        Payment opens the portal in a tab: card details are handled by Stripe on its own domain, and
        are never typed into this window.
      </p>
    </section>
  )
}

function Field({
  label,
  problem,
  children
}: {
  label: string
  problem?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mt-3">
      <label className="mb-1.5 block text-[11.5px] text-[var(--color-text-muted)]">{label}</label>
      {children}
      {problem && <p className="mt-1 text-[11.5px] text-[var(--color-bad)]">{problem}</p>}
    </div>
  )
}

function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  step
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  type?: string
  /** Whole hours for the date pickers: the database refuses a part-hour run. */
  step?: number
}): React.JSX.Element {
  return (
    <input
      type={type}
      value={value}
      step={step}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-lg border border-[var(--glass-edge)] bg-white/[0.04] px-3 py-2 text-[13px] outline-none focus:border-[var(--color-accent)]"
    />
  )
}

function Select({
  value,
  onChange,
  children
}: {
  value: string
  onChange: (next: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      // The dropdown itself is drawn by the operating system, not by this
      // document: a list styled here is a list of white text on white,
      // which is what a country picker looked like. `color-scheme` is what
      // tells the platform to draw its own widget dark.
      style={{ colorScheme: 'dark' }}
      className="w-full cursor-default rounded-lg border border-[var(--glass-edge)] bg-white/[0.04] px-3 py-2 text-[13px] outline-none focus:border-[var(--color-accent)]"
    >
      {children}
    </select>
  )
}
