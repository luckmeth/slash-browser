/**
 * One setting: what it is on the left, the control on the right.
 *
 * The screens here used to put the control *above* its explanation, inside a
 * card per setting — so the thing you came to change sat in a different place
 * on every row and the eye had nowhere to run down. Principle 7 asks these
 * screens to say what a setting costs in plain language, and they did; the
 * cost was a screen that read like documentation with inputs scattered
 * through it.
 *
 * Nothing is deleted here. The sentence moves under the label, where it is
 * read *while* deciding rather than before finding the control.
 */
export function Field({
  label,
  why,
  htmlFor,
  wide = false,
  after,
  children
}: {
  label: string
  why?: React.ReactNode
  /** Omit when the control is not a single labellable input (a switch, a pair). */
  htmlFor?: string
  wide?: boolean
  /** What the value means, in the browser's own words. Sits under the control. */
  after?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="field">
      <div className="what">
        {htmlFor ? (
          <label htmlFor={htmlFor}>{label}</label>
        ) : (
          <span className="name">{label}</span>
        )}
        {why && <p className="why">{why}</p>}
      </div>
      <div className={wide ? 'control wide' : 'control'}>
        {children}
        {after && <div className="after">{after}</div>}
      </div>
    </div>
  )
}

/** A group of fields under one heading, as a single card with hairlines. */
export function Group({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="group">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

/**
 * A real switch.
 *
 * On and off are visible without reading anything, which a JSON box reading
 * `true` is not. The word beside it stays because a switch alone does not say
 * which way is on to somebody who has not used this screen before.
 */
export function Switch({
  name,
  checked,
  onChange,
  on = 'On',
  off = 'Off',
  id
}: {
  name?: string
  checked: boolean
  onChange?: (next: boolean) => void
  on?: string
  off?: string
  id?: string
}): React.JSX.Element {
  return (
    <label className="switch">
      <input
        id={id}
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(event) => onChange?.(event.target.checked)}
      />
      <span className="track" aria-hidden="true" />
      <span className="state">{checked ? on : off}</span>
    </label>
  )
}

/** A number with its unit shown rather than implied by the label. */
export function Measure({
  id,
  value,
  onChange,
  unit,
  lead,
  step,
  min,
  max,
  placeholder
}: {
  id: string
  value: string
  onChange: (next: string) => void
  /** Sits after the box: "coins / hour", "hours", "days". */
  unit?: string
  /** Sits before it, for a currency symbol. */
  lead?: string
  step?: string
  min?: string
  max?: string
  placeholder?: string
}): React.JSX.Element {
  return (
    <div className="measure">
      {lead && <span className="lead">{lead}</span>}
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={value}
        step={step}
        min={min}
        max={max}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  )
}
