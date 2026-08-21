import { describe, it, expect } from 'vitest'
import { mapResourceType } from './resourceTypes'

describe('mapResourceType', () => {
  it('renames the types the two vocabularies spell differently', () => {
    // These are the ones that matter: a filter rule is written `$xhr`, and if
    // the request never carries that type the rule silently never applies.
    expect(mapResourceType('xhr')).toBe('xmlhttprequest')
    expect(mapResourceType('mainFrame')).toBe('main_frame')
    expect(mapResourceType('subFrame')).toBe('sub_frame')
    expect(mapResourceType('webSocket')).toBe('websocket')
    expect(mapResourceType('cspReport')).toBe('csp_report')
  })

  it('passes through the types that already agree', () => {
    for (const type of ['script', 'image', 'stylesheet', 'font', 'media', 'object', 'ping']) {
      expect(mapResourceType(type)).toBe(type)
    }
  })

  it('falls back to "other" for anything unrecognised', () => {
    // Electron can add resource types; an unknown one must degrade to a type
    // the lists handle rather than to something that matches nothing.
    expect(mapResourceType('someFutureType')).toBe('other')
    expect(mapResourceType('')).toBe('other')
  })

  it('never returns a camelCase Electron name', () => {
    // The failure this guards: a mismatch does not throw, it just quietly
    // applies the wrong rules.
    const electronTypes = [
      'mainFrame',
      'subFrame',
      'stylesheet',
      'script',
      'image',
      'font',
      'object',
      'xhr',
      'ping',
      'cspReport',
      'media',
      'webSocket',
      'other'
    ]
    for (const type of electronTypes) {
      expect(mapResourceType(type)).not.toMatch(/[A-Z]/)
    }
  })
})
