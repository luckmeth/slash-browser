import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { formatCents } from '@slash/ad-shared'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

/**
 * One advertiser: the company, and everything they have submitted.
 *
 * The campaign list is the history a review decision should be made against.
 * A queue shows one campaign; this shows that this is the fourth from a
 * company whose first three were rejected, which is the fact that changes what
 * you do about the fourth.
 */
export default async function AdvertiserPage({
  params
}: {
  params: Promise<{ id: string }>
}): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')
  const { id } = await params

  const service = supabaseService()
  const [advertiser, campaigns, payments] = await Promise.all([
    service.from('advertisers').select('*').eq('id', id).maybeSingle(),
    service
      .from('campaigns')
      .select('id, title, status, total_cost, total_hours, starts_at, ends_at, placement_tier, review_note')
      .eq('advertiser_id', id)
      .order('starts_at', { ascending: false })
      .limit(100),
    service.from('payments').select('amount, status, created_at').eq('advertiser_id', id)
  ])

  if (!advertiser.data) notFound()
  const company = advertiser.data

  const succeeded = (payments.data ?? []).filter((row) => row.status === 'succeeded')
  const paid = succeeded.reduce((sum, row) => sum + Number(row.amount ?? 0), 0)

  return (
    <main>
      <p className="note">
        <Link href="/advertisers">← Advertisers</Link>
      </p>
      <h1>{company.company_name}</h1>
      <p className="lede">
        {company.contact_email}
        {company.status !== 'active' && (
          <>
            {' '}
            <span className="pill rejected">{company.status}</span>
          </>
        )}
      </p>

      <div className="tiles">
        <div className="tile">
          <div className="k">Campaigns</div>
          <div className="v">{(campaigns.data ?? []).length}</div>
          <div className="sub">
            {(campaigns.data ?? []).filter((row) => row.status === 'pending_review').length} waiting
            on review
          </div>
        </div>
        <div className="tile">
          <div className="k">Paid</div>
          <div className="v small">{formatCents(paid)}</div>
          <div className="sub">{succeeded.length} successful payments</div>
        </div>
        <div className="tile">
          <div className="k">Company profile</div>
          <div className={company.profile_updated_at ? 'v small good' : 'v small warn'}>
            {company.profile_updated_at ? 'Filled in' : 'Not filled in'}
          </div>
          <div className="sub">
            {company.profile_updated_at
              ? new Date(company.profile_updated_at).toLocaleDateString()
              : 'they have not completed it'}
          </div>
        </div>
        <div className="tile">
          <div className="k">Joined</div>
          <div className="v small">{new Date(company.created_at).toLocaleDateString()}</div>
          <div className="sub">account created</div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <section className="group">
          <h2>What readers see</h2>
          <Detail label="Company name" value={company.company_name} />
          <Detail label="Website" value={company.website} link />
          <Detail label="What they do" value={company.description} />
        </section>

        <section className="group">
          <h2>For us only</h2>
          <Detail label="Contact" value={company.contact_name} />
          <Detail label="Email" value={company.contact_email} />
          <Detail label="Phone" value={company.contact_phone} />
          <Detail
            label="Address"
            value={[company.address_line1, company.city, company.postcode, company.country]
              .filter((part) => (part ?? '') !== '')
              .join(', ')}
          />
          <Detail label="VAT / company no." value={company.tax_id} />
        </section>
      </div>

      <h2>Campaigns</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Placement</th>
              <th>Runs</th>
              <th className="num">Cost</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(campaigns.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="note">
                  Nothing submitted yet.
                </td>
              </tr>
            ) : (
              (campaigns.data ?? []).map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.title}
                    {row.review_note && <div className="note">{row.review_note}</div>}
                  </td>
                  <td className="note">{row.placement_tier}</td>
                  <td className="note">
                    {new Date(row.starts_at).toLocaleDateString()} —{' '}
                    {new Date(row.ends_at).toLocaleDateString()}
                  </td>
                  <td className="num">{formatCents(Number(row.total_cost ?? 0))}</td>
                  <td>
                    <span className={`pill ${row.status}`}>{String(row.status).replace(/_/g, ' ')}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}

function Detail({
  label,
  value,
  link = false
}: {
  label: string
  value: string | null | undefined
  link?: boolean
}): React.JSX.Element {
  const text = (value ?? '').trim()
  return (
    <div className="field">
      <div className="what">
        <span className="name">{label}</span>
      </div>
      <div className="control wide">
        <span style={{ textAlign: 'right', color: text === '' ? 'var(--muted)' : undefined }}>
          {text === '' ? (
            'not given'
          ) : link ? (
            // Opened in a new tab and told not to pass a referrer: this is an
            // address an advertiser typed, and it should not learn where it
            // was clicked from.
            <a href={text} target="_blank" rel="noreferrer noopener">
              {text}
            </a>
          ) : (
            text
          )}
        </span>
      </div>
    </div>
  )
}
