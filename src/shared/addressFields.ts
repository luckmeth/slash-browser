/**
 * Working out what an input on a page is asking for.
 *
 * In `shared/` with **zero imports**, because the scanning half runs in
 * `preload/content.ts` — which must stay tiny and must never pull zod in — and
 * the deciding half runs in main. One copy, so the two cannot disagree about
 * what a field is.
 *
 * Getting this wrong is not a cosmetic failure: it puts a postcode in a phone
 * box, or an email address in a street field, on a form the user is about to
 * submit. So the signals are ranked, and anything ambiguous returns null rather
 * than a guess — a field left empty is obvious and fixable, a field filled
 * wrongly often is not.
 */

export type AddressFieldKind =
  | 'name'
  | 'givenName'
  | 'familyName'
  | 'organization'
  | 'streetLine1'
  | 'streetLine2'
  | 'city'
  | 'region'
  | 'postalCode'
  | 'country'
  | 'phone'
  | 'email'

/** What a page tells us about one input. All optional; pages are inconsistent. */
export interface FieldHints {
  readonly autocomplete?: string
  readonly name?: string
  readonly id?: string
  readonly placeholder?: string
  readonly label?: string
  readonly type?: string
}

/**
 * The `autocomplete` tokens the HTML standard defines, which are the only
 * signal here that is a statement of intent rather than an inference.
 */
const AUTOCOMPLETE: Record<string, AddressFieldKind> = {
  name: 'name',
  'given-name': 'givenName',
  'family-name': 'familyName',
  organization: 'organization',
  'street-address': 'streetLine1',
  'address-line1': 'streetLine1',
  'address-line2': 'streetLine2',
  'address-level2': 'city',
  'address-level1': 'region',
  'postal-code': 'postalCode',
  'country-name': 'country',
  country: 'country',
  tel: 'phone',
  'tel-national': 'phone',
  email: 'email'
}

/**
 * Word patterns, in priority order.
 *
 * Order matters and is not alphabetical. `address-line2` must be tested before
 * `address`, or every second line is filled with the first; `family` before
 * `name`, or every surname box gets the full name.
 */
const PATTERNS: { kind: AddressFieldKind; pattern: RegExp }[] = [
  { kind: 'email', pattern: /\b(e-?mail)\b/i },
  { kind: 'phone', pattern: /\b(phone|tel|mobile|telephone)\b/i },
  { kind: 'postalCode', pattern: /\b(post(al)?[\s_-]?code|zip([\s_-]?code)?|pincode)\b/i },
  { kind: 'country', pattern: /\bcountry\b/i },
  { kind: 'region', pattern: /\b(state|province|region|county)\b/i },
  { kind: 'city', pattern: /\b(city|town|suburb|locality)\b/i },
  { kind: 'streetLine2', pattern: /\b(address[\s_-]?(line)?[\s_-]?2|apt|apartment|unit|suite|flat)\b/i },
  { kind: 'streetLine1', pattern: /\b(street|address[\s_-]?(line)?[\s_-]?1?|addr)\b/i },
  { kind: 'organization', pattern: /\b(company|organi[sz]ation|business|employer)\b/i },
  { kind: 'familyName', pattern: /\b(last[\s_-]?name|family[\s_-]?name|surname|lname)\b/i },
  { kind: 'givenName', pattern: /\b(first[\s_-]?name|given[\s_-]?name|forename|fname)\b/i },
  { kind: 'name', pattern: /\b(full[\s_-]?name|your[\s_-]?name|name)\b/i }
]

/** Inputs that are never an address field, whatever they are called. */
const EXCLUDED_TYPES = new Set([
  'password',
  'hidden',
  'submit',
  'button',
  'checkbox',
  'radio',
  'file',
  'image',
  'reset',
  'range',
  'color'
])

/**
 * What this field wants, or null if it cannot be told.
 *
 * `autocomplete` wins outright when present and recognised: it is the page
 * author saying what the field is, and no amount of pattern-matching on a name
 * attribute beats being told.
 */
export function classifyField(hints: FieldHints): AddressFieldKind | null {
  const type = (hints.type ?? 'text').toLowerCase()
  if (EXCLUDED_TYPES.has(type)) return null

  // A search box on a shop's checkout page matches /address/ often enough to
  // matter, and filling it is both wrong and visible.
  if (type === 'search') return null

  const autocomplete = (hints.autocomplete ?? '').toLowerCase().trim()
  if (autocomplete !== '' && autocomplete !== 'off' && autocomplete !== 'on') {
    // Tokens may carry a section or a billing/shipping prefix — "shipping
    // address-line1". The meaningful token is the last one.
    const tokens = autocomplete.split(/\s+/)
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const mapped = AUTOCOMPLETE[tokens[index]!]
      if (mapped) return mapped
    }
  }

  if (type === 'email') return 'email'
  if (type === 'tel') return 'phone'

  const haystack = [hints.name, hints.id, hints.placeholder, hints.label]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // streetAddress -> street Address
    // Every non-alphanumeric run becomes a single space before the word-boundary
    // tests below. Underscore is a WORD character in JavaScript regular
    // expressions, so a boundary never falls beside one — and a pattern for
    // "city" would not match inside billing_city, which is exactly how form
    // fields are named.
    .replace(/[^a-z0-9]+/gi, ' ')
    .toLowerCase()

  if (haystack.trim() === '') return null

  for (const { kind, pattern } of PATTERNS) {
    if (pattern.test(haystack)) return kind
  }
  return null
}

/**
 * One saved address. Every field optional — people have partial ones, and half
 * an address filled correctly beats a form that refuses to help at all.
 */
export interface SavedAddress {
  readonly id: number
  readonly label: string
  readonly name: string
  readonly givenName: string
  readonly familyName: string
  readonly organization: string
  readonly streetLine1: string
  readonly streetLine2: string
  readonly city: string
  readonly region: string
  readonly postalCode: string
  readonly country: string
  readonly phone: string
  readonly email: string
}

/**
 * The value for a field kind, or '' when there is nothing to put there.
 *
 * `name` falls back to joining the given and family names, because plenty of
 * forms ask for one full name while the address was saved as two parts — and
 * the reverse, splitting a full name, is guesswork nobody should do to a
 * person's name.
 */
export function valueFor(address: SavedAddress, kind: AddressFieldKind): string {
  if (kind === 'name' && address.name.trim() === '') {
    return [address.givenName, address.familyName].filter((part) => part.trim() !== '').join(' ')
  }
  return address[kind] ?? ''
}

/** Which of a page's fields this address can actually fill. */
export function fillableKinds(
  address: SavedAddress,
  present: readonly AddressFieldKind[]
): AddressFieldKind[] {
  return present.filter((kind) => valueFor(address, kind).trim() !== '')
}
