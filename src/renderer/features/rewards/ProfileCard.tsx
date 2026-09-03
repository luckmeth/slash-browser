import { useEffect, useMemo, useState } from 'react'
import { countryOptions } from '@shared/countries'
import { checkProfile, WALLET_NETWORKS, WALLET_NETWORK_LABELS } from '@shared/profileRules'
import type { CoinProfile, CoinProfileInput } from '@shared/types/rewards'
import { Icon } from '../../components/Icon'

/**
 * The details a collector gives once, after signing in.
 *
 * Asked here rather than in the sign-in flow on purpose. Signing in is a
 * Google window and a redirect; interrupting it with an eight-field form is
 * how people abandon both. This sits on the rewards page instead, states why
 * each part is wanted, and can be finished later — the balance keeps accruing
 * either way, because nothing about earning depends on knowing somebody's
 * address. It is the *payout* that would.
 *
 * Three things it is careful to say, because this is the first personal
 * information the browser has ever asked for:
 *
 * - **The email is the Google account.** Shown, not editable. A contact
 *   address a client can set is a payout notice an attacker can redirect.
 * - **A wallet address cannot be checked by us.** The shape is checked so a
 *   truncated paste and a Solana address in an Ethereum field are caught, and
 *   the screen says plainly that a payout to a wrong address cannot be undone.
 * - **It is stored against the account, and nobody else can read it.** Not
 *   shared, not sold, not sent anywhere except the Slash service the account
 *   already talks to.
 */
export function ProfileCard({ email }: { email: string }): React.JSX.Element {
  const [profile, setProfile] = useState<CoinProfile | null>(null)
  const [form, setForm] = useState<CoinProfileInput | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showing, setShowing] = useState(false)
  const [serverProblems, setServerProblems] = useState<Record<string, string>>({})

  const countries = useMemo(() => countryOptions(), [])

  useEffect(() => {
    void window.browser.invoke('rewards:profile', undefined).then((result) => {
      if (!result.ok || result.value === null) return
      setProfile(result.value)
      setForm(toInput(result.value))
      // An unfinished profile opens itself. A finished one stays folded away:
      // it is a form somebody filled in months ago, not something to re-read
      // every time they check a balance.
      setShowing(!result.value.complete)
    })
  }, [])

  // Live, so somebody sees a wallet address go from wrong to right as they
  // paste it rather than after pressing Save.
  const problems = useMemo(
    () => (form ? checkProfile(form, Date.now()) : []),
    [form]
  )
  const problemFor = (field: keyof CoinProfileInput): string | undefined =>
    serverProblems[field] ?? problems.find((entry) => entry.field === field)?.problem

  if (!form || !profile) return <></>

  const set = (field: keyof CoinProfileInput, value: string): void => {
    setSaved(false)
    setServerProblems({})
    setForm({ ...form, [field]: value })
  }

  const save = (): void => {
    setSaving(true)
    setServerProblems({})
    void window.browser.invoke('rewards:saveProfile', form).then((result) => {
      setSaving(false)
      if (!result.ok) {
        setServerProblems({ fullName: 'Could not reach the rewards service.' })
        return
      }
      if (!result.value.ok) {
        const map: Record<string, string> = {}
        for (const entry of result.value.problems) map[entry.field] = entry.problem
        setServerProblems(map)
        return
      }
      if (result.value.profile) {
        setProfile(result.value.profile)
        setForm(toInput(result.value.profile))
      }
      setSaved(true)
    })
  }

  return (
    <section className="slash-reveal glass-raised mt-3 overflow-hidden rounded-2xl border border-[var(--glass-edge)]">
      <button
        type="button"
        onClick={() => setShowing(!showing)}
        className="flex w-full cursor-default items-center gap-3 px-5 py-4 text-left transition hover:bg-white/[0.03]"
      >
        <Icon name={profile.complete ? 'star' : 'warning'} size={15} />
        <span className="flex-1">
          <span className="block text-[13.5px] font-medium">Your details</span>
          <span className="block text-[12px] text-[var(--color-text-muted)]">
            {profile.complete
              ? profile.walletAddress === ''
                ? 'Saved. No payout wallet added yet.'
                : `Saved. Payouts would go to your ${
                    WALLET_NETWORK_LABELS[
                      profile.walletNetwork as keyof typeof WALLET_NETWORK_LABELS
                    ] ?? profile.walletNetwork
                  } wallet.`
              : 'Needed before any payout can reach you. It takes a minute, and earning carries on either way.'}
          </span>
        </span>
        {!profile.complete && (
          <span className="rounded-full bg-[var(--color-warn)]/15 px-2.5 py-1 text-[11px] text-[var(--color-warn)]">
            Not filled in
          </span>
        )}
        <Icon name="expand" size={14} className={showing ? 'rotate-180 transition' : 'transition'} />
      </button>

      {showing && (
        <div className="border-t border-[var(--glass-edge)] px-5 py-5">
          <p className="mb-4 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            Stored against your Slash Coin account and readable by nobody else. It is here so a
            payout has somewhere to go and a name to go under — none of it is needed to browse, and
            none of it is collected from your machine.
          </p>

          <Row label="Email">
            <div className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-[13px] text-[var(--color-text-muted)]">
              <Icon name="lock" size={13} />
              {email || profile.email}
              <span className="ml-auto text-[11px]">from your Google sign-in</span>
            </div>
          </Row>

          <div className="grid gap-3 sm:grid-cols-2">
            <Row label="Full name" problem={problemFor('fullName')}>
              <Input value={form.fullName} onChange={(v) => set('fullName', v)} placeholder="As it appears on your ID" />
            </Row>
            <Row label="Date of birth" problem={problemFor('dateOfBirth')}>
              <Input type="date" value={form.dateOfBirth} onChange={(v) => set('dateOfBirth', v)} />
            </Row>
          </div>

          <Row label="Address" problem={problemFor('addressLine1')}>
            <Input value={form.addressLine1} onChange={(v) => set('addressLine1', v)} placeholder="Street address" />
          </Row>
          <Row label="">
            <Input
              value={form.addressLine2}
              onChange={(v) => set('addressLine2', v)}
              placeholder="Apartment, floor (optional)"
            />
          </Row>

          <div className="grid gap-3 sm:grid-cols-3">
            <Row label="Town or city" problem={problemFor('city')}>
              <Input value={form.city} onChange={(v) => set('city', v)} />
            </Row>
            <Row label="Region">
              <Input value={form.region} onChange={(v) => set('region', v)} placeholder="Optional" />
            </Row>
            <Row label="Postcode">
              <Input value={form.postcode} onChange={(v) => set('postcode', v)} placeholder="Optional" />
            </Row>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Row label="Country" problem={problemFor('country')}>
              <Select value={form.country} onChange={(v) => set('country', v)}>
                <option value="">Choose a country</option>
                {countries.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name}
                  </option>
                ))}
              </Select>
            </Row>
            <Row label="Phone" problem={problemFor('phone')}>
              <Input value={form.phone} onChange={(v) => set('phone', v)} placeholder="+94 77 123 4567" />
            </Row>
          </div>

          <div className="mt-5 rounded-xl border border-[var(--glass-edge)] bg-white/[0.02] p-4">
            <h3 className="text-[13px] font-medium">Payout wallet</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
              Where coins would be sent if they ever become transferable. Optional for now — you can
              add it later. <strong>Check it against your wallet before saving:</strong> a transfer
              to a wrong address cannot be undone by us or by anybody else.
            </p>

            <div className="mt-3 grid gap-3 sm:grid-cols-[170px_1fr]">
              <Row label="Network" problem={problemFor('walletNetwork')}>
                <Select value={form.walletNetwork} onChange={(v) => set('walletNetwork', v)}>
                  <option value="">None yet</option>
                  {WALLET_NETWORKS.map((network) => (
                    <option key={network} value={network}>
                      {WALLET_NETWORK_LABELS[network]}
                    </option>
                  ))}
                </Select>
              </Row>
              <Row label="Address" problem={problemFor('walletAddress')}>
                <Input
                  value={form.walletAddress}
                  onChange={(v) => set('walletAddress', v)}
                  placeholder={form.walletNetwork === '' ? 'Choose a network first' : 'Paste your wallet address'}
                  mono
                />
              </Row>
            </div>
          </div>

          {/* One switch, in the form they are already filling in. A
              preference nobody can find is a preference that does not exist,
              and a broadcast with no way out is what gets a sending domain
              blocked. Slash Operations honours it. */}
          <label className="mt-4 flex cursor-default items-start gap-2.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              checked={!form.emailOptOut}
              onChange={(event) => {
                setSaved(false)
                setForm({ ...form, emailOptOut: !event.target.checked })
              }}
              className="mt-0.5"
            />
            <span>
              Email me about Slash Coin — rate changes, the launch, and anything that affects a
              balance. Turning this off still leaves the messages the service has to send, like a
              payout confirmation.
            </span>
          </label>

          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving || problems.length > 0}
              className="cursor-default rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-[13px] font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? 'Saving…' : profile.complete ? 'Save changes' : 'Save my details'}
            </button>
            {saved && (
              <span className="text-[12px] text-[var(--color-good)]">Saved.</span>
            )}
            {!saved && problems.length > 0 && (
              <span className="text-[12px] text-[var(--color-text-muted)]">
                {problems.length} {problems.length === 1 ? 'field needs' : 'fields need'} attention
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function toInput(profile: CoinProfile): CoinProfileInput {
  return {
    fullName: profile.fullName,
    dateOfBirth: profile.dateOfBirth,
    addressLine1: profile.addressLine1,
    addressLine2: profile.addressLine2,
    city: profile.city,
    region: profile.region,
    postcode: profile.postcode,
    country: profile.country,
    phone: profile.phone,
    walletAddress: profile.walletAddress,
    walletNetwork: profile.walletNetwork,
    emailOptOut: profile.emailOptOut
  }
}

function Row({
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
      {label !== '' && (
        <label className="mb-1.5 block text-[11.5px] text-[var(--color-text-muted)]">{label}</label>
      )}
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
  mono = false
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  type?: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      className={`w-full rounded-lg border border-[var(--glass-edge)] bg-white/[0.04] px-3 py-2 text-[13px] outline-none focus:border-[var(--color-accent)] ${
        mono ? 'font-mono text-[12px]' : ''
      }`}
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
      className="w-full cursor-default rounded-lg border border-[var(--glass-edge)] bg-white/[0.04] px-3 py-2 text-[13px] outline-none focus:border-[var(--color-accent)]"
    >
      {children}
    </select>
  )
}
