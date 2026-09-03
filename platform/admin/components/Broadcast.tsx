'use client'

import { useActionState, useState } from 'react'
import { sendBroadcast, type BroadcastResult } from '@/app/emails/send/actions'
import { AUDIENCES, BROADCAST_CAP, footerFor, type Audience } from '@/app/emails/send/audiences'
import { Field, Group } from './Field'

/**
 * Writing one message to a list of people.
 *
 * The two things this screen is built around are both about the moment before
 * pressing send, because that is the only moment that can be changed.
 *
 * **The count is in front of you and has to be typed back.** Not a checkbox —
 * a checkbox is ticked without reading. The number is re-counted on the server
 * when the button is pressed, so a list that grew between loading the page and
 * sending is refused rather than silently reaching more people than were
 * confirmed.
 *
 * **The preview is the real thing.** Same frame, same greeting, same footer as
 * the message that goes out, so what an operator approves is what a person
 * receives.
 */
export function Broadcast({
  counts
}: {
  counts: Record<Audience, number>
}): React.JSX.Element {
  const [state, action, sending] = useActionState<BroadcastResult, FormData>(
    sendBroadcast,
    undefined
  )

  const [audience, setAudience] = useState<Audience>('collectors')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [confirm, setConfirm] = useState('')

  const reach = counts[audience] ?? 0
  const chosen = AUDIENCES.find((entry) => entry.value === audience)
  const ready = subject.trim() !== '' && body.trim() !== '' && confirm === String(reach) && reach > 0

  return (
    <form action={action}>
      <Group title="Who it goes to">
        <Field
          label="Audience"
          htmlFor="audience"
          wide
          why={chosen?.why}
          after={
            reach === 0 ? (
              'nobody matches this yet'
            ) : (
              <>
                reaches <strong>{reach.toLocaleString()}</strong>{' '}
                {reach === 1 ? 'person' : 'people'}
              </>
            )
          }
        >
          <select
            id="audience"
            name="audience"
            value={audience}
            onChange={(event) => {
              setAudience(event.target.value as Audience)
              // The confirmation is a count, and the count just changed.
              setConfirm('')
            }}
          >
            {AUDIENCES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label} ({counts[entry.value] ?? 0})
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="People who opted out"
          why="Collectors can turn off anything beyond the messages the service has to send, from their details in the browser. They are already excluded from every count on this page — there is no way to include them."
        >
          <span className="note">excluded</span>
        </Field>
      </Group>

      <Group title="The message">
        <Field label="Subject" htmlFor="subject" wide why="What an inbox shows. Keep it short enough to read there.">
          <input
            id="subject"
            name="subject"
            type="text"
            value={subject}
            maxLength={160}
            placeholder="Slash Coin — the launch date is set"
            onChange={(event) => setSubject(event.target.value)}
          />
        </Field>

        <Field
          label="Message"
          htmlFor="body"
          wide
          why="Plain text. A blank line starts a new paragraph, and nothing else is interpreted — an unescaped angle bracket in a sentence about pricing should not break the layout for everybody on the list."
        >
          <textarea
            id="body"
            name="body"
            value={body}
            rows={9}
            placeholder={'We have published a value for Slash Coin.\n\nIt is indicative only, and nothing can be exchanged during pre-launch.'}
            onChange={(event) => setBody(event.target.value)}
          />
        </Field>
      </Group>

      {(subject.trim() !== '' || body.trim() !== '') && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>What they will see</h3>
          <div
            style={{
              border: '1px solid var(--edge)',
              borderRadius: 8,
              padding: 18,
              background: '#ffffff',
              color: '#1b1f27',
              maxWidth: 520
            }}
          >
            <p style={{ margin: '0 0 14px', fontSize: 19, fontWeight: 600 }}>
              {subject || 'No subject'}
            </p>
            <p style={{ margin: '0 0 10px' }}>Hello Ada,</p>
            {body.split(/\n{2,}/).map((block, index) => (
              <p key={index} style={{ margin: '0 0 10px', lineHeight: 1.55 }}>
                {block}
              </p>
            ))}
            <p style={{ marginTop: 24, fontSize: 12, color: '#6b7280' }}>
              Slash. {footerFor(audience)}
            </p>
          </div>
          <p className="note" style={{ marginTop: 10 }}>
            The frame, the greeting and the footer are the real ones — what is drawn here is what
            arrives, including the line explaining how they ended up on this list.
          </p>
        </div>
      )}

      <Group title="Send">
        <Field
          label="Confirm the number"
          htmlFor="confirm"
          why={`Type ${reach} — the number of people this reaches. It is counted again when you press send, so a list that grew in the meantime is refused rather than quietly reaching more people than you confirmed.`}
          after={
            confirm === '' ? null : confirm === String(reach) ? (
              <span className="ok">matches</span>
            ) : (
              <span className="after bad">that is not {reach}</span>
            )
          }
        >
          <input
            id="confirm"
            name="confirm"
            type="text"
            inputMode="numeric"
            value={confirm}
            placeholder={String(reach)}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>
      </Group>

      <div className="savebar">
        <button type="submit" disabled={!ready || sending}>
          {sending ? 'Sending…' : `Send to ${reach}`}
        </button>
        {state && 'error' in state && <p className="said bad">{state.error}</p>}
        {state && 'ok' in state && <p className="said good">{state.ok}</p>}
        {!state && (
          <p className="said">
            Sent one at a time, up to {BROADCAST_CAP} per send. Do not close the window while it
            runs. Every message is written to the email log.
          </p>
        )}
      </div>
    </form>
  )
}
