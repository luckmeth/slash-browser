'use client'

import { useActionState, useRef, useState } from 'react'
import { savePlatformSetting, saveBrowserSetting, type SaveResult } from '@/app/settings/actions'
import { Field, Measure, Switch } from './Field'

/**
 * A setting, as a control rather than as its storage format.
 *
 * Both settings tables hold `jsonb`, and the screens used to hand an operator
 * that fact: a textarea per row containing `true`, or `12`, or `"usd"` with
 * the quotes load-bearing. It works, and it means the person changing a
 * support email address has to know that a string needs quotes and a number
 * must not have them — a fact about our storage, being asked of somebody
 * deciding a business question.
 *
 * The value still travels as JSON, because the server action parses it as JSON
 * and refusing malformed input is worth keeping. The difference is that the
 * JSON is produced here, from a control that cannot produce the wrong shape:
 * a switch can only send `true` or `false`, a number field can only send a
 * number.
 *
 * `Raw` remains for anything with no descriptor, so a key added to the
 * database tomorrow is editable today rather than invisible.
 */

type Target = 'platform' | 'browser'

function actionFor(target: Target): typeof savePlatformSetting {
  return target === 'platform' ? savePlatformSetting : saveBrowserSetting
}

/**
 * The frame every setting shares: one form, one row, one hidden JSON value.
 *
 * Save appears only once something has changed. A row of permanent Save
 * buttons reads as work waiting to be done, and on a screen of seventeen of
 * them there is no way to see which one you actually edited.
 */
function Row({
  settingKey,
  target,
  label,
  why,
  json,
  dirty,
  wide,
  after,
  submitOnChange = false,
  children,
  htmlFor
}: {
  settingKey: string
  target: Target
  label: string
  why?: React.ReactNode
  /** The value to store, already JSON. */
  json: string
  dirty: boolean
  wide?: boolean
  after?: React.ReactNode
  /** For switches: a control whose whole interaction is the change itself. */
  submitOnChange?: boolean
  children: React.ReactNode
  htmlFor?: string
}): React.JSX.Element {
  const [state, action, saving] = useActionState<SaveResult, FormData>(actionFor(target), undefined)
  const form = useRef<HTMLFormElement>(null)

  return (
    <form
      ref={form}
      action={action}
      // Enter in a text field is a save, which is what people expect of a
      // single-field row and what the JSON textareas could not offer.
      onChange={submitOnChange ? () => form.current?.requestSubmit() : undefined}
    >
      <input type="hidden" name="key" value={settingKey} />
      <input type="hidden" name="value" value={json} />
      <Field
        label={label}
        why={why}
        wide={wide}
        htmlFor={htmlFor}
        after={
          <>
            {after}
            {state && 'error' in state && (
              <div className="after bad">{state.error}</div>
            )}
            {state && 'ok' in state && !dirty && <div className="ok">Saved.</div>}
            {dirty && !submitOnChange && (
              <button type="submit" disabled={saving} style={{ padding: '6px 14px', fontSize: 13 }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
            {saving && submitOnChange && <div>Saving…</div>}
          </>
        }
      >
        {children}
      </Field>
    </form>
  )
}

export function BooleanSetting({
  settingKey,
  target,
  label,
  why,
  value,
  on,
  off
}: {
  settingKey: string
  target: Target
  label: string
  why?: React.ReactNode
  value: boolean
  on?: string
  off?: string
}): React.JSX.Element {
  const [next, setNext] = useState(value)
  return (
    <Row
      settingKey={settingKey}
      target={target}
      label={label}
      why={why}
      json={JSON.stringify(next)}
      dirty={next !== value}
      submitOnChange
    >
      <Switch checked={next} onChange={setNext} on={on} off={off} />
    </Row>
  )
}

export function NumberSetting({
  settingKey,
  target,
  label,
  why,
  value,
  unit,
  step,
  min,
  max,
  after
}: {
  settingKey: string
  target: Target
  label: string
  why?: React.ReactNode
  value: number
  unit?: string
  step?: string
  min?: string
  max?: string
  after?: (typed: number) => React.ReactNode
}): React.JSX.Element {
  const [text, setText] = useState(String(value))
  const typed = Number(text)
  const valid = text.trim() !== '' && Number.isFinite(typed)

  return (
    <Row
      settingKey={settingKey}
      target={target}
      label={label}
      why={why}
      htmlFor={`v-${settingKey}`}
      // An unreadable field sends the stored value rather than NaN, which is
      // not valid JSON and would be refused with a message about JSON — true,
      // and no help to somebody who simply cleared a box.
      json={JSON.stringify(valid ? typed : value)}
      dirty={valid && typed !== value}
      after={valid ? after?.(typed) : 'Needs a number.'}
    >
      <Measure
        id={`v-${settingKey}`}
        value={text}
        onChange={setText}
        unit={unit}
        step={step}
        min={min}
        max={max}
      />
    </Row>
  )
}

export function TextSetting({
  settingKey,
  target,
  label,
  why,
  value,
  placeholder,
  type = 'text',
  wide = true
}: {
  settingKey: string
  target: Target
  label: string
  why?: React.ReactNode
  value: string
  placeholder?: string
  type?: 'text' | 'email' | 'url'
  wide?: boolean
}): React.JSX.Element {
  const [text, setText] = useState(value)
  return (
    <Row
      settingKey={settingKey}
      target={target}
      label={label}
      why={why}
      htmlFor={`v-${settingKey}`}
      json={JSON.stringify(text)}
      dirty={text !== value}
      wide={wide}
    >
      <input
        id={`v-${settingKey}`}
        type={type}
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
      />
    </Row>
  )
}

export function ChoiceSetting({
  settingKey,
  target,
  label,
  why,
  value,
  options,
  after
}: {
  settingKey: string
  target: Target
  label: string
  why?: React.ReactNode
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  after?: (chosen: string) => React.ReactNode
}): React.JSX.Element {
  const [chosen, setChosen] = useState(value)
  return (
    <Row
      settingKey={settingKey}
      target={target}
      label={label}
      why={why}
      htmlFor={`v-${settingKey}`}
      json={JSON.stringify(chosen)}
      dirty={chosen !== value}
      after={after?.(chosen)}
    >
      <select
        id={`v-${settingKey}`}
        value={chosen}
        onChange={(event) => setChosen(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Row>
  )
}

/**
 * The start-page notice: three fields instead of an object.
 *
 * This one is worth the extra component. It is the single thing on these
 * screens that appears **in front of every user of the browser**, and it was
 * edited as `{"message": "", "level": "info", "url": ""}` — where deleting a
 * brace publishes nothing, and `"level": "warning"` (a plausible guess; the
 * browser wants `warn`) publishes a notice the browser silently drops.
 */
export function NoticeSetting({
  value
}: {
  value: { message?: string; level?: string; url?: string }
}): React.JSX.Element {
  const [message, setMessage] = useState(value.message ?? '')
  const [level, setLevel] = useState(value.level ?? 'info')
  const [url, setUrl] = useState(value.url ?? '')

  const dirty =
    message !== (value.message ?? '') || level !== (value.level ?? 'info') || url !== (value.url ?? '')

  return (
    <Row
      settingKey="notice"
      target="browser"
      label="Start-page notice"
      wide
      why={
        <>
          Shown on the start page of every copy of Slash. An empty message shows nothing at all,
          which is how a notice is taken down. A link must be <code>https</code> — the browser
          refuses anything else rather than putting it in front of people.
        </>
      }
      json={JSON.stringify({ message, level, url })}
      dirty={dirty}
      after={
        message.trim() === '' ? (
          'nothing is shown'
        ) : (
          <>
            shown to <strong>every user</strong>
          </>
        )
      }
    >
      <input
        aria-label="Notice message"
        type="text"
        value={message}
        placeholder="Empty — no notice shown"
        onChange={(event) => setMessage(event.target.value)}
      />
      <select
        aria-label="Notice level"
        value={level}
        onChange={(event) => setLevel(event.target.value)}
      >
        <option value="info">Info — quiet</option>
        <option value="warn">Warn — amber</option>
        <option value="urgent">Urgent — red</option>
      </select>
      <input
        aria-label="Notice link"
        type="url"
        value={url}
        placeholder="Optional https:// link"
        spellCheck={false}
        onChange={(event) => setUrl(event.target.value)}
      />
    </Row>
  )
}

/**
 * Rollout flags: a switch each, and a box to add one.
 *
 * The browser treats a flag it does not recognise, and one that is missing, as
 * off — so removing a row here turns a flag off rather than breaking anything,
 * and that is worth saying on the screen rather than in a comment.
 */
export function FlagsSetting({
  value
}: {
  value: Record<string, boolean>
}): React.JSX.Element {
  const [flags, setFlags] = useState<Record<string, boolean>>(value)
  const [fresh, setFresh] = useState('')

  const dirty = JSON.stringify(flags) !== JSON.stringify(value)
  const names = Object.keys(flags).sort()

  return (
    <Row
      settingKey="feature_flags"
      target="browser"
      label="Rollout flags"
      wide
      why="The browser treats an unknown flag, and a missing one, as off — so removing a flag turns it off rather than breaking anything."
      json={JSON.stringify(flags)}
      dirty={dirty}
      after={names.length === 0 ? 'no flags set' : `${names.filter((n) => flags[n]).length} of ${names.length} on`}
    >
      {names.length > 0 && (
        <div className="stack" style={{ width: '100%', gap: 8 }}>
          {names.map((name) => (
            <div key={name} className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <code style={{ fontSize: 12.5 }}>{name}</code>
              <div className="row" style={{ gap: 6 }}>
                <Switch
                  checked={flags[name] === true}
                  onChange={(next) => setFlags({ ...flags, [name]: next })}
                />
                <button
                  type="button"
                  className="secondary"
                  style={{ padding: '4px 10px', fontSize: 12 }}
                  onClick={() => {
                    const next = { ...flags }
                    delete next[name]
                    setFlags(next)
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ width: '100%', gap: 6 }}>
        <input
          aria-label="New flag name"
          type="text"
          value={fresh}
          placeholder="new_flag_name"
          spellCheck={false}
          onChange={(event) => setFresh(event.target.value)}
        />
        <button
          type="button"
          className="secondary"
          disabled={fresh.trim() === ''}
          onClick={() => {
            setFlags({ ...flags, [fresh.trim()]: false })
            setFresh('')
          }}
        >
          Add
        </button>
      </div>
    </Row>
  )
}

/**
 * The escape hatch, for a key with no descriptor yet.
 *
 * A settings screen that only renders what it has been taught about hides
 * anything added to the database since — so an unrecognised key still gets its
 * JSON box, labelled as one.
 */
export function RawSetting({
  settingKey,
  target,
  value
}: {
  settingKey: string
  target: Target
  value: unknown
}): React.JSX.Element {
  const stored = JSON.stringify(value, null, 2)
  const [text, setText] = useState(stored)

  return (
    <Row
      settingKey={settingKey}
      target={target}
      label={settingKey}
      why="No description for this one yet, so it is edited as stored: JSON, where text needs quotes and numbers and true/false do not."
      json={text}
      dirty={text !== stored}
      wide
      htmlFor={`v-${settingKey}`}
    >
      <textarea
        id={`v-${settingKey}`}
        value={text}
        rows={Math.min(stored.split('\n').length + 1, 12)}
        spellCheck={false}
        style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
        onChange={(event) => setText(event.target.value)}
      />
    </Row>
  )
}
