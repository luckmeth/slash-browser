// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What these controls actually submit.
 *
 * The screen is a row of controls over a `jsonb` table, so every one of them
 * has to turn an interaction into the exact JSON the server action will parse.
 * That is not something a typecheck can check, and it went wrong immediately:
 * a switch submitted the value it had *before* the click, because
 * `requestSubmit()` ran in the same tick as `setState` and the hidden input
 * still held the old value. The row then reported "Saved." and nothing had
 * changed — which is what a settings page that does not work looks like.
 *
 * So the assertion here is on the FormData the action receives, not on what
 * the screen shows.
 */

const saved: FormData[] = []

// The real actions are 'use server' modules that pull in the Supabase client
// and the environment schema; neither belongs in a test of a control.
vi.mock('@/app/settings/actions', () => ({
  savePlatformSetting: async (_previous: unknown, formData: FormData) => {
    saved.push(formData)
    return { ok: 'Saved.' }
  },
  saveBrowserSetting: async (_previous: unknown, formData: FormData) => {
    saved.push(formData)
    return { ok: 'Saved.' }
  }
}))

const {
  BooleanSetting,
  ChoiceSetting,
  FlagsSetting,
  NoticeSetting,
  NumberSetting,
  RawSetting,
  TextSetting
} = await import('./SettingField')

/** What the last submission would store, parsed the way the action parses it. */
function lastValue(): unknown {
  const form = saved[saved.length - 1]
  if (!form) throw new Error('nothing was submitted')
  return JSON.parse(String(form.get('value')))
}

function lastKey(): string {
  return String(saved[saved.length - 1]?.get('key'))
}

/** The form only submits after React has rendered the new hidden value. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  saved.length = 0
  // jsdom implements requestSubmit only in newer versions; make the missing
  // case loud rather than letting a test pass because nothing submitted.
  if (!HTMLFormElement.prototype.requestSubmit) {
    HTMLFormElement.prototype.requestSubmit = function requestSubmit(this: HTMLFormElement) {
      this.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    }
  }
})

afterEach(cleanup)

describe('BooleanSetting', () => {
  it('submits the value it was switched TO, not the one it had', async () => {
    // The bug this file was written for. Flipping on submitted `false`.
    render(
      <BooleanSetting settingKey="show_advertise_cta" target="browser" label="Offer" value={false} />
    )

    fireEvent.click(screen.getByRole('checkbox'))
    await settle()

    expect(saved).toHaveLength(1)
    expect(lastKey()).toBe('show_advertise_cta')
    expect(lastValue()).toBe(true)
  })

  it('submits false when switched off', async () => {
    render(<BooleanSetting settingKey="show_advertise_cta" target="browser" label="Offer" value />)

    fireEvent.click(screen.getByRole('checkbox'))
    await settle()

    expect(lastValue()).toBe(false)
  })

  it('does not submit on mount, when nothing has been touched', async () => {
    render(<BooleanSetting settingKey="show_advertise_cta" target="browser" label="Offer" value />)
    await settle()
    expect(saved).toHaveLength(0)
  })

  it('submits once per flip rather than on every render', async () => {
    render(
      <BooleanSetting settingKey="show_advertise_cta" target="browser" label="Offer" value={false} />
    )
    fireEvent.click(screen.getByRole('checkbox'))
    await settle()
    await settle()
    expect(saved).toHaveLength(1)
  })
})

describe('NumberSetting', () => {
  it('sends a JSON number, not a string', async () => {
    render(
      <NumberSetting
        settingKey="min_lead_time_hours"
        target="platform"
        label="Lead time"
        value={12}
      />
    )

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '24' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await settle()

    expect(lastValue()).toBe(24)
    expect(typeof lastValue()).toBe('number')
  })

  it('offers no Save until the number actually changes', () => {
    render(
      <NumberSetting
        settingKey="min_lead_time_hours"
        target="platform"
        label="Lead time"
        value={12}
      />
    )
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('keeps the stored value rather than sending NaN for a cleared box', async () => {
    render(
      <NumberSetting
        settingKey="min_lead_time_hours"
        target="platform"
        label="Lead time"
        value={12}
      />
    )
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } })

    // No Save offered, and were one forced, the value would still be valid
    // JSON: NaN is not, and the refusal would talk about JSON to somebody who
    // simply cleared a field.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByText('Needs a number.')).toBeTruthy()
  })
})

describe('TextSetting', () => {
  it('sends a quoted JSON string', async () => {
    render(
      <TextSetting settingKey="support_email" target="platform" label="Support" value="" />
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi@slash.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await settle()

    expect(lastValue()).toBe('hi@slash.test')
  })

  it('can clear a value back to empty', async () => {
    render(
      <TextSetting settingKey="support_email" target="platform" label="Support" value="x@y.test" />
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await settle()

    expect(lastValue()).toBe('')
  })
})

describe('ChoiceSetting', () => {
  it('sends the chosen option', async () => {
    render(
      <ChoiceSetting
        settingKey="stripe_mode"
        target="platform"
        label="Mode"
        value="test"
        options={[
          { value: 'test', label: 'Test' },
          { value: 'live', label: 'Live' }
        ]}
      />
    )

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'live' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await settle()

    expect(lastValue()).toBe('live')
  })
})

describe('NoticeSetting', () => {
  it('submits the three fields as one object', async () => {
    render(<NoticeSetting value={{ message: '', level: 'info', url: '' }} />)

    fireEvent.change(screen.getByLabelText('Notice message'), {
      target: { value: 'Maintenance on Sunday' }
    })
    fireEvent.change(screen.getByLabelText('Notice level'), { target: { value: 'warn' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await settle()

    expect(lastValue()).toEqual({ message: 'Maintenance on Sunday', level: 'warn', url: '' })
  })

  it('can only offer levels the browser understands', () => {
    // "warning" is the plausible guess that a JSON box accepted and the
    // browser silently dropped.
    render(<NoticeSetting value={{ message: 'x', level: 'info', url: '' }} />)
    const levels = Array.from(
      screen.getByLabelText('Notice level').querySelectorAll('option')
    ).map((option) => option.getAttribute('value'))
    expect(levels).toEqual(['info', 'warn', 'urgent'])
  })
})

describe('FlagsSetting', () => {
  it('adds a flag, off by default', async () => {
    render(<FlagsSetting value={{}} />)

    fireEvent.change(screen.getByLabelText('New flag name'), { target: { value: 'new_thing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await settle()

    expect(lastValue()).toEqual({ new_thing: false })
  })

  it('turns one on without disturbing the others', async () => {
    render(<FlagsSetting value={{ alpha: true, beta: false }} />)

    // Two switches, in sorted order.
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await settle()

    expect(lastValue()).toEqual({ alpha: true, beta: true })
  })

  it('removes one, which is how a flag is turned off for good', async () => {
    render(<FlagsSetting value={{ alpha: true }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await settle()

    expect(lastValue()).toEqual({})
  })
})

describe('RawSetting', () => {
  it('still exists, so a key nobody has described is not invisible', async () => {
    render(<RawSetting settingKey="something_new" target="platform" value={{ a: 1 }} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"a": 2}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await settle()

    expect(lastValue()).toEqual({ a: 2 })
  })
})
