import { redirect } from 'next/navigation'
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

  return (
    <main>
      <h1>Email log</h1>
      <p className="lede">
        Every send attempted, including the ones that failed. &ldquo;Did they get the
        receipt?&rdquo; is otherwise unanswerable, and the first time anyone asks is when somebody
        says they were charged without being told.
      </p>

      {failures > 0 && (
        <p className="banner">
          {failures} of the last {(data ?? []).length} sends failed. Check RESEND_API_KEY and
          EMAIL_FROM.
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
                  Nothing sent yet.
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
