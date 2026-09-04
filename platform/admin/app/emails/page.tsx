import Link from 'next/link'
import { redirect } from 'next/navigation'
import { emailConfigured } from '@/lib/env'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

export default async function EmailLogPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const { data } = await supabaseService()
    .from('email_log')
    .select('id, type, recipient, status, error, sent_at')
    .order('sent_at', { ascending: false })
    .limit(100)

  const failures = (data ?? []).filter((row) => row.status === 'failed').length
  const configured = emailConfigured()

  return (
    <main>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ marginBottom: 0 }}>Email log</h1>
        <Link href="/emails/send" className="button secondary">
          Send a message
        </Link>
      </div>
      <p className="lede">
        Every send attempted, including the ones that failed. &ldquo;Did they get the
        receipt?&rdquo; is otherwise unanswerable, and the first time anyone asks is when somebody
        says they were charged without being told.
      </p>

      {/*
        Whether sending is possible at all, stated whatever the table holds. An
        empty log means "nothing has been attempted", and with no key set that
        is indistinguishable from "nothing can be sent" — which is exactly how
        this screen was read for weeks.
      */}
      {!configured && (
        <p className="banner">
          No email can be sent: the Resend API key, the From address, or both, are not set. Every
          attempt will be recorded here as <strong>failed</strong>. In Slash Operations they are
          under <strong>Setup → Database key and email delivery</strong>; on a web deployment they
          are <code>RESEND_API_KEY</code> and <code>EMAIL_FROM</code> in the host environment.
        </p>
      )}

      {configured && failures > 0 && (
        <p className="banner">
          {failures} of the last {(data ?? []).length} sends failed. The key and From address are
          set, so the reason beside each row came from Resend — an unverified sending domain is the
          usual one.
        </p>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>To</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={4} className="note">
                  {configured
                    ? 'Nothing sent yet. Sending is configured, so the first approval, rejection or receipt will appear here.'
                    : 'Nothing sent, and nothing can be until a key and From address are set.'}
                </td>
              </tr>
            ) : (
              (data ?? []).map((row) => (
                <tr key={row.id}>
                  <td className="note">{new Date(row.sent_at).toLocaleString()}</td>
                  <td>{row.type.replace(/_/g, ' ')}</td>
                  <td className="note">{row.recipient}</td>
                  <td>
                    <span className={`pill ${row.status}`}>{row.status}</span>
                    {row.error && <div className="note">{row.error}</div>}
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
