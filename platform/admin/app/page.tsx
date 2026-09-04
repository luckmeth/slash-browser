import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatCents } from '@slash/ad-shared'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

export default async function OverviewPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const supabase = supabaseService()
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)

  const [pending, running, scheduled, advertisers, payments, lastCron] = await Promise.all([
    supabase.from('campaigns').select('id', { count: 'exact', head: true }).eq('status', 'pending_review'),
    supabase.from('campaigns').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('campaigns').select('id', { count: 'exact', head: true }).eq('status', 'scheduled'),
    supabase.from('advertisers').select('id', { count: 'exact', head: true }),
    supabase
      .from('payments')
      .select('amount')
      .eq('status', 'succeeded')
      .gte('paid_at', monthStart.toISOString()),
    supabase
      .from('campaigns')
      .select('updated_at')
      .in('status', ['active', 'completed'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  ])

  const revenueCents = (payments.data ?? []).reduce(
    (total, row) => total + Math.round(Number(row.amount) * 100),
    0
  )

  // If nothing has changed state in over a day while campaigns are waiting, the
  // scheduled job is probably not running — which is silent, and means paid
  // campaigns never start and finished ones never stop being served.
  const lastMove = lastCron.data?.updated_at ? Date.parse(lastCron.data.updated_at) : 0
  const cronLooksStuck =
    (scheduled.count ?? 0) + (running.count ?? 0) > 0 &&
    lastMove > 0 &&
    Date.now() - lastMove > 36 * 60 * 60 * 1000

  return (
    <main>
      <h1>Overview</h1>

      {(pending.count ?? 0) > 0 && (
        <p className="banner">
          {pending.count} campaign{pending.count === 1 ? '' : 's'} paid for and waiting for review.{' '}
          <Link href="/queue">Open the queue</Link>.
        </p>
      )}

      {cronLooksStuck && (
        <p className="banner" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>
          No campaign has changed state in over a day. The scheduled job at
          <code> /api/cron/advance</code> may not be running — while it is stopped, paid campaigns
          never start and finished ones keep being served.
        </p>
      )}

      <div className="grid">
        <Stat label="Waiting for review" value={String(pending.count ?? 0)} href="/queue" />
        <Stat label="Running now" value={String(running.count ?? 0)} />
        <Stat label="Approved, not started" value={String(scheduled.count ?? 0)} />
        <Stat label="Advertisers" value={String(advertisers.count ?? 0)} />
        <Stat label="Paid this month" value={formatCents(revenueCents)} />
      </div>

      <h2>Before this takes real money</h2>
      <div className="card">
        <ol className="note" style={{ paddingLeft: 20, margin: 0 }}>
          <li>
            A schedule calling <code>/api/cron/advance</code>. Nothing else moves a campaign from
            approved to running, or from running to finished.
          </li>
          <li>
            A Stripe webhook pointed at <code>/api/stripe/webhook</code>. The success redirect is a
            URL anyone can visit; only the signed webhook proves a payment happened.
          </li>
          <li>
            Live Stripe keys in the host environment, and <code>stripe_mode</code> set to
            &ldquo;live&rdquo; in Settings.
          </li>
          <li>
            <code>RESEND_API_KEY</code> and <code>EMAIL_FROM</code>, or nobody is told anything —
            check the email log after the first payment.
          </li>
        </ol>
      </div>
    </main>
  )
}

function Stat({
  label,
  value,
  href
}: {
  label: string
  value: string
  href?: string
}): React.JSX.Element {
  const body = (
    <div className="card">
      <div className="note">{label}</div>
      <div className="hero-cost">{value}</div>
    </div>
  )
  return href ? <Link href={href}>{body}</Link> : body
}
