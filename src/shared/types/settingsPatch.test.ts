import { describe, expect, it } from 'vitest'
import { SettingsPatchSchema, SettingsSchema } from './settings'

describe('SettingsPatchSchema', () => {
  it('keeps a one-key patch to one key', () => {
    // The bug this exists for: `.partial()` still applies every `.default()`,
    // so an absent key parsed to its default and the merge in
    // `SettingsStore.update` reset every other setting. Two switches, and the
    // first came back off.
    const parsed = SettingsPatchSchema.parse({ blockMaliciousSites: false }) as Record<
      string,
      unknown
    >
    expect(Object.keys(parsed)).toEqual(['blockMaliciousSites'])
    expect('blockAds' in parsed).toBe(false)
  })

  it('is the difference from .partial(), demonstrated', () => {
    const viaPartial = SettingsSchema.partial().parse({ blockMaliciousSites: false })
    const viaPatch = SettingsPatchSchema.parse({ blockMaliciousSites: false })
    expect(Object.keys(viaPartial).length).toBeGreaterThan(50)
    expect(Object.keys(viaPatch).length).toBe(1)
  })

  it('still validates the values it is given', () => {
    expect(() => SettingsPatchSchema.parse({ blockAds: 'yes' })).toThrow()
    expect(() => SettingsPatchSchema.parse({ downloadConnections: 999 })).toThrow()
  })

  it('accepts several keys at once', () => {
    const parsed = SettingsPatchSchema.parse({ blockAds: false, downloadConnections: 4 })
    expect(parsed).toEqual({ blockAds: false, downloadConnections: 4 })
  })

  it('accepts an empty patch', () => {
    expect(SettingsPatchSchema.parse({})).toEqual({})
  })

  it('covers every writable key', () => {
    // A key missing here would be silently unwritable from the UI. Checked by
    // round-tripping each one rather than by reading the shape, which the
    // public type deliberately hides.
    const sample: Record<string, unknown> = SettingsSchema.parse({})
    for (const key of Object.keys(SettingsSchema.shape)) {
      const parsed = SettingsPatchSchema.parse({ [key]: sample[key] }) as Record<string, unknown>
      expect(Object.keys(parsed)).toEqual([key])
    }
  })
})
