import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Broadcast } from '@/components/Broadcast'
import { audienceFor } from './actions'
import { AUDIENCES, type Audience } from './audiences'
import { emailConfigured } from '@/lib/env'
import { currentAdmin } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * One message to a list of people.
 *
 * The counts are resolved here, on the server, by the same query the send
 * uses — so the number on the button, the number in the confirmation and the
 * number of messages that leave are the same number by construction rather
 * than by three pieces of code agreeing.
 */
export default async function SendPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const entries = await Promise.all(
    AUDIENCES.map(async (entry) => [entry.value, (await audienceFor(entry.value)).length] as const)
  )
  const counts = Object.fromEntries(entries) as Record<Audience, number>

  return (
    <main>
      <p className="note">
        <Link href="/emails">← Email log</Link>
      </p>
      <h1>Send a message</h1>
      <p className="lede">
        One message to a chosen group. This is the most irreversible thing in this application —
        a campaign can be rejected and a price changed back, but a delivered email is delivered.
      </p>

      {!emailConfigured() && (
        <p className="banner">
          No email can be sent: the Resend API key, the From address, or both, are not set. In Slash
          Operations they are under <strong>Setup → Database key and email delivery</strong>. You can
          write the message, but sending will be refused.
        </p>
      )}

      <Broadcast counts={counts} />
    </main>
  )
}
