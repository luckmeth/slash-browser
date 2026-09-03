// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Two guards, both written after the same defect.
 *
 * `/settings` passed a **function** from a server component to a client one to
 * render a hint computed from the typed value. React refuses that, so every
 * request to the page threw before rendering anything — and nothing caught it:
 * the typecheck is happy (the prop type is a function), `next build` never
 * renders a `force-dynamic` page, and no test rendered the page at all. The
 * only trace was one line in the server log.
 *
 * So: every catalogue entry is rendered here, and the pages themselves are
 * scanned for the shape of the mistake.
 */

const saved: FormData[] = []

vi.mock('@/app/settings/actions', () => ({
  savePlatformSetting: async (_p: unknown, formData: FormData) => {
    saved.push(formData)
    return { ok: 'Saved.' }
  },
  saveBrowserSetting: async (_p: unknown, formData: FormData) => {
    saved.push(formData)
    return { ok: 'Saved.' }
  }
}))

const { PlatformSetting, BrowserSetting, groupOf } = await import('./settingsCatalogue')

beforeEach(() => {
  saved.length = 0
})
afterEach(cleanup)

describe('every setting the pages can hand to the catalogue', () => {
  // The keys as they exist in the live database, with the shapes they hold.
  const PLATFORM: ReadonlyArray<[string, unknown]> = [
    ['stripe_mode', 'test'],
    ['stripe_publishable_key', ''],
    ['currency', 'usd'],
    ['support_email', ''],
    ['min_lead_time_hours', 12]
  ]

  const BROWSER: ReadonlyArray<[string, unknown]> = [
    ['show_advertise_cta', true],
    ['notice', { message: '', level: 'info', url: '' }],
    ['feature_flags', {}]
  ]

  it.each(PLATFORM)('renders %s', (key, value) => {
    render(<PlatformSetting settingKey={key} value={value} />)
    expect(document.querySelector('form')).toBeTruthy()
  })

  it.each(BROWSER)('renders %s', (key, value) => {
    render(<BrowserSetting settingKey={key} value={value} />)
    expect(document.querySelector('form')).toBeTruthy()
  })

  it('puts every described key in a group the page lays out', () => {
    for (const [key] of PLATFORM) expect(groupOf('platform', key)).toBeTruthy()
    for (const [key] of BROWSER) expect(groupOf('browser', key)).toBeTruthy()
  })

  it('falls back to a JSON box for a key nobody has described', () => {
    expect(groupOf('platform', 'invented_yesterday')).toBeNull()
    render(<PlatformSetting settingKey="invented_yesterday" value={{ a: 1 }} />)
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('survives a row holding the wrong shape entirely', () => {
    // These rows were hand-edited as JSON for months. A page that throws on a
    // malformed row cannot be used to fix the row, which is the only reason
    // anybody would open it.
    render(<BrowserSetting settingKey="notice" value="a string, somehow" />)
    expect(screen.getByLabelText('Notice message')).toBeTruthy()
    cleanup()
    render(<BrowserSetting settingKey="feature_flags" value={null} />)
    expect(screen.getByLabelText('New flag name')).toBeTruthy()
  })
})

describe('the value a described control actually submits', () => {
  it('sends the chosen mode', async () => {
    render(<PlatformSetting settingKey="stripe_mode" value="test" />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'live' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(JSON.parse(String(saved[0]?.get('value')))).toBe('live')
  })

  it('sends lead time as a number', async () => {
    render(<PlatformSetting settingKey="min_lead_time_hours" value={12} />)
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '24' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(JSON.parse(String(saved[0]?.get('value')))).toBe(24)
  })
})

/**
 * The mistake itself, as a rule about the source.
 *
 * A server component may not pass a function to a client component. The
 * typecheck cannot see it, the build cannot see it, and rendering the pages
 * here would not reproduce it either — the error comes from the RSC
 * serializer, which no test in this repository runs. So the shape is checked
 * in the text: an inline arrow in a prop, in a file with no `'use client'`.
 */
describe('no server page passes a function to a client component', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const appDir = join(here, '..', 'app')

  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.tsx')) files.push(path)
    }
  }
  walk(appDir)

  it.each(files)('%s', (path) => {
    const source = readFileSync(path, 'utf8')
    if (source.includes("'use client'")) return

    // `prop={(` starts an inline arrow or a parenthesised expression; the
    // latter is rare enough in these files to be worth the false positive,
    // and `prop={function` covers the other form.
    const offenders = source
      .split('\n')
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => /\w+=\{\(/.test(line) || /\w+=\{function\b/.test(line))
      .map(([line, text]) => `line ${line}: ${text.trim()}`)

    expect(
      offenders,
      `A server component may not pass a function to a client component; React throws at request time and the build cannot see it. Move the logic into the client component (see settingsCatalogue.tsx).\n${offenders.join('\n')}`
    ).toEqual([])
  })
})
