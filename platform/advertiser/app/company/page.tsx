import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CompanyForm } from '@/components/CompanyForm'
import { currentAdvertiser, supabaseServer } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * The advertiser's own company profile.
 *
 * Read through their session rather than the service-role client: row-level
 * security already restricts `advertisers` to their own row, so this page is
 * incapable of showing somebody else's company even if the filter were wrong.
 */
export default async function CompanyPage(): Promise<React.JSX.Element> {
  const advertiser = await currentAdvertiser()
  if (!advertiser) redirect('/login')

  const supabase = await supabaseServer()
  const { data, error } = await supabase
    .from('advertisers')
    .select('*')
    .eq('auth_user_id', advertiser.authUserId)
    .maybeSingle()

  return (
    <main>
      <h1>Your company</h1>
      <p className="lede">
        Who is paying for the advert, and where to reach you about it. Filled in once — every
        campaign you submit uses it.
      </p>

      {error && (
        <p className="error">
          Could not read your company profile ({error.message}). If this mentions a missing column,
          this deployment needs <code>20260903_collector_profiles.sql</code> applied.
        </p>
      )}

      <CompanyForm company={data ?? { company_name: advertiser.company_name, contact_email: advertiser.contact_email }} />

      <p className="note" style={{ marginTop: 24 }}>
        <Link href="/campaigns/new">Submit a campaign →</Link>
      </p>
    </main>
  )
}
