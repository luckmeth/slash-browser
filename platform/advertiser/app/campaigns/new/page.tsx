import { redirect } from 'next/navigation'
import { CampaignForm } from '@/components/CampaignForm'
import { currentAdvertiser } from '@/lib/supabase/server'
import { loadSettings, loadTiers } from '@/lib/settings'
import { isTestMode } from '@/lib/stripe'
import { paymentsConfigured } from '@/lib/env'

export const dynamic = 'force-dynamic'

export default async function NewCampaignPage(): Promise<React.JSX.Element> {
  const advertiser = await currentAdvertiser()
  if (!advertiser) redirect('/login')

  if (advertiser.status === 'suspended') {
    return (
      <main className="narrow">
        <h1>Account suspended</h1>
        <p className="lede">
          This account cannot book new campaigns at the moment. Existing ones are unaffected.
        </p>
      </main>
    )
  }

  const [tiers, settings] = await Promise.all([loadTiers(), loadSettings()])

  return (
    <main className="narrow">
      <h1>New campaign</h1>
      <p className="lede">
        The price updates as you choose a window. You are charged once, for the hours you pick.
      </p>

      {/* Somebody who believes they are taking real money while running against
          Stripe's test keys finds out at the end of the month, from their bank.
          This is the one banner worth being unmissable. */}
      {!paymentsConfigured() ? (
        <p className="banner">
          Payments are not configured on this deployment. You can build a campaign and it will be
          saved, but there is no way to pay for it yet.
        </p>
      ) : isTestMode() ? (
        <p className="banner">
          Test mode. Card payments here are simulated and no money moves. Use Stripe&rsquo;s test
          card 4242 4242 4242 4242 with any future expiry.
        </p>
      ) : null}

      <CampaignForm
        tiers={tiers}
        minLeadHours={settings.minLeadTimeHours}
        currency={settings.currency}
        advertiserAuthId={advertiser.authUserId}
        companyName={advertiser.company_name}
      />
    </main>
  )
}
