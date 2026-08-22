import { describe, it, expect } from 'vitest'
import {
  classifyField,
  fillableKinds,
  valueFor,
  type SavedAddress
} from './addressFields'

describe('classifyField — autocomplete wins', () => {
  it('reads the standard tokens', () => {
    // The page author saying what the field is. No amount of pattern-matching
    // on a name attribute beats being told.
    expect(classifyField({ autocomplete: 'postal-code' })).toBe('postalCode')
    expect(classifyField({ autocomplete: 'address-line1' })).toBe('streetLine1')
    expect(classifyField({ autocomplete: 'address-line2' })).toBe('streetLine2')
    expect(classifyField({ autocomplete: 'address-level2' })).toBe('city')
    expect(classifyField({ autocomplete: 'family-name' })).toBe('familyName')
  })

  it('reads a token carrying a shipping or billing prefix', () => {
    expect(classifyField({ autocomplete: 'shipping address-line1' })).toBe('streetLine1')
    expect(classifyField({ autocomplete: 'section-one billing postal-code' })).toBe('postalCode')
  })

  it('beats a misleading name attribute', () => {
    expect(classifyField({ autocomplete: 'email', name: 'user_city' })).toBe('email')
  })

  it('ignores autocomplete="off" and falls through to the heuristics', () => {
    expect(classifyField({ autocomplete: 'off', name: 'zipcode' })).toBe('postalCode')
  })
})

describe('classifyField — heuristics', () => {
  it('recognises common name attributes', () => {
    expect(classifyField({ name: 'zip' })).toBe('postalCode')
    expect(classifyField({ name: 'billing_city' })).toBe('city')
    expect(classifyField({ name: 'phone_number' })).toBe('phone')
  })

  it('splits camelCase before matching', () => {
    expect(classifyField({ name: 'streetAddress' })).toBe('streetLine1')
    expect(classifyField({ id: 'postalCode' })).toBe('postalCode')
  })

  it('tests address line 2 before address, so the second line is not the first', () => {
    // Order in the pattern table is load-bearing. Reversed, every "address 2"
    // box gets line one and the real line two is lost.
    expect(classifyField({ name: 'address_line_2' })).toBe('streetLine2')
    expect(classifyField({ name: 'address_line_1' })).toBe('streetLine1')
    expect(classifyField({ placeholder: 'Apartment, suite, unit' })).toBe('streetLine2')
  })

  it('tests surname before name, so a last-name box is not given the full name', () => {
    expect(classifyField({ name: 'last_name' })).toBe('familyName')
    expect(classifyField({ label: 'Surname' })).toBe('familyName')
    expect(classifyField({ name: 'first_name' })).toBe('givenName')
    expect(classifyField({ label: 'Full name' })).toBe('name')
  })

  it('uses the label when the name is meaningless', () => {
    expect(classifyField({ name: 'f_17', label: 'Town or city' })).toBe('city')
  })

  it('uses the input type as a signal', () => {
    expect(classifyField({ type: 'email' })).toBe('email')
    expect(classifyField({ type: 'tel' })).toBe('phone')
  })
})

describe('classifyField — refusing to guess', () => {
  it('returns null for a field it cannot identify', () => {
    // A field left empty is obvious and fixable. A field filled wrongly on a
    // form about to be submitted often is not.
    expect(classifyField({ name: 'quantity' })).toBeNull()
    expect(classifyField({})).toBeNull()
    expect(classifyField({ name: '' })).toBeNull()
  })

  it('never touches a password field', () => {
    expect(classifyField({ type: 'password', name: 'address' })).toBeNull()
  })

  it('never touches hidden, checkbox or button inputs', () => {
    expect(classifyField({ type: 'hidden', name: 'city' })).toBeNull()
    expect(classifyField({ type: 'checkbox', name: 'city' })).toBeNull()
    expect(classifyField({ type: 'submit', name: 'city' })).toBeNull()
  })

  it('leaves a search box alone even when it matches', () => {
    // Shops put "Search addresses" boxes on checkout pages. Filling one is both
    // wrong and immediately visible.
    expect(classifyField({ type: 'search', name: 'address_search' })).toBeNull()
  })
})

const address: SavedAddress = {
  id: 1,
  label: 'Home',
  name: '',
  givenName: 'Ada',
  familyName: 'Lovelace',
  organization: '',
  streetLine1: '12 Example Street',
  streetLine2: '',
  city: 'London',
  region: '',
  postalCode: 'SW1A 1AA',
  country: 'United Kingdom',
  phone: '',
  email: 'ada@example.com'
}

describe('valueFor', () => {
  it('returns the stored value', () => {
    expect(valueFor(address, 'city')).toBe('London')
  })

  it('builds a full name from the parts when none was stored', () => {
    // Plenty of forms want one name box while the address was saved as two.
    expect(valueFor(address, 'name')).toBe('Ada Lovelace')
  })

  it('prefers a stored full name over the parts', () => {
    expect(valueFor({ ...address, name: 'A. Lovelace' }, 'name')).toBe('A. Lovelace')
  })

  it('returns empty for something not saved', () => {
    expect(valueFor(address, 'phone')).toBe('')
  })
})

describe('fillableKinds', () => {
  it('leaves out fields this address has nothing for', () => {
    // Filling a phone box with an empty string still counts as touching it, and
    // a form that reports "phone is required" after being autofilled is worse
    // than one that was never touched.
    expect(fillableKinds(address, ['city', 'phone', 'postalCode'])).toEqual(['city', 'postalCode'])
  })

  it('includes a name derived from the parts', () => {
    expect(fillableKinds(address, ['name'])).toEqual(['name'])
  })
})
