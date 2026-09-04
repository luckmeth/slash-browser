import { describe, expect, it } from 'vitest'
import credentials from './credentials.js'

const { parseCredentials, serialiseCredentials, describeCredentials, emailConfigured, checkSetup } =
  credentials

const stored = {
  serviceKey: 'eyJstored',
  resendApiKey: 're_stored',
  emailFrom: 'Slash <ads@slash.test>'
}

describe('parseCredentials', () => {
  it('reads the record written by this version', () => {
    expect(parseCredentials(serialiseCredentials(stored))).toEqual(stored)
  })

  it('reads a bare key written before email was configurable here', () => {
    // The whole point: an operator who updates must not be asked for the key
    // again, so the old format has to keep working.
    expect(parseCredentials('eyJold')).toEqual({
      serviceKey: 'eyJold',
      resendApiKey: '',
      emailFrom: ''
    })
    expect(parseCredentials('sb_secret_old').serviceKey).toBe('sb_secret_old')
  })

  it('fills absent email fields rather than returning undefined', () => {
    expect(parseCredentials(JSON.stringify({ serviceKey: 'eyJa' }))).toEqual({
      serviceKey: 'eyJa',
      resendApiKey: '',
      emailFrom: ''
    })
  })

  it('treats JSON that is not a credentials record as a bare key', () => {
    expect(parseCredentials('123').serviceKey).toBe('123')
    expect(parseCredentials('{"other":1}').serviceKey).toBe('{"other":1}')
  })
})

describe('describeCredentials', () => {
  it('reports that secrets exist and never what they are', () => {
    const description = describeCredentials(stored)
    expect(description).toEqual({
      hasServiceKey: true,
      hasResendKey: true,
      emailFrom: 'Slash <ads@slash.test>'
    })
    expect(JSON.stringify(description)).not.toContain('eyJstored')
    expect(JSON.stringify(description)).not.toContain('re_stored')
  })

  it('describes nothing stored', () => {
    expect(describeCredentials(null)).toEqual({
      hasServiceKey: false,
      hasResendKey: false,
      emailFrom: ''
    })
  })
})

describe('emailConfigured', () => {
  it('needs both halves', () => {
    expect(emailConfigured(stored)).toBe(true)
    expect(emailConfigured({ ...stored, resendApiKey: '' })).toBe(false)
    expect(emailConfigured({ ...stored, emailFrom: '' })).toBe(false)
    expect(emailConfigured(null)).toBe(false)
  })
})

describe('checkSetup — the service key', () => {
  it('accepts both key formats on first run', () => {
    expect(checkSetup({ key: 'eyJnew' }, null)).toEqual({
      ok: true,
      credentials: { serviceKey: 'eyJnew', resendApiKey: '', emailFrom: '' }
    })
    expect(checkSetup({ key: 'sb_secret_new' }, null).ok).toBe(true)
  })

  it('refuses a pasted anon key by shape', () => {
    expect(checkSetup({ key: 'not-a-key' }, null).ok).toBe(false)
  })

  it('needs a key when none is stored', () => {
    const result = checkSetup({ key: '' }, null)
    expect(result.ok).toBe(false)
    expect(result.problem).toMatch(/service_role/)
  })

  it('keeps the stored key when the field is left blank', () => {
    const result = checkSetup({ key: '', emailFrom: '' }, stored)
    expect(result.ok).toBe(true)
    expect(result.credentials.serviceKey).toBe('eyJstored')
  })

  it('replaces the stored key when a new one is typed', () => {
    const result = checkSetup({ key: 'sb_secret_fresh', emailFrom: stored.emailFrom }, stored)
    expect(result.credentials.serviceKey).toBe('sb_secret_fresh')
  })

  it('trims what was pasted', () => {
    expect(checkSetup({ key: '  eyJspaced \n' }, null).credentials.serviceKey).toBe('eyJspaced')
  })
})

describe('checkSetup — email delivery', () => {
  it('stores both halves together', () => {
    const result = checkSetup(
      { key: '', resendApiKey: 're_fresh', emailFrom: 'ads@slash.test' },
      stored
    )
    expect(result.credentials).toEqual({
      serviceKey: 'eyJstored',
      resendApiKey: 're_fresh',
      emailFrom: 'ads@slash.test'
    })
  })

  it('keeps the stored Resend key when only the From address changes', () => {
    const result = checkSetup({ key: '', resendApiKey: '', emailFrom: 'new@slash.test' }, stored)
    expect(result.credentials.resendApiKey).toBe('re_stored')
    expect(result.credentials.emailFrom).toBe('new@slash.test')
  })

  it('turns delivery off when the From address is cleared, and drops the key with it', () => {
    // Off has to mean the secret is gone. A dormant key is one accidental
    // re-entry away from sending from an account nobody remembers configuring.
    const result = checkSetup({ key: '', resendApiKey: '', emailFrom: '' }, stored)
    expect(result.ok).toBe(true)
    expect(result.credentials.resendApiKey).toBe('')
    expect(result.credentials.emailFrom).toBe('')
  })

  it('refuses a key with no From address rather than discarding the key', () => {
    const result = checkSetup({ key: '', resendApiKey: 're_fresh', emailFrom: '' }, stored)
    expect(result.ok).toBe(false)
    expect(result.problem).toMatch(/From address/)
  })

  it('refuses a From address with no key anywhere', () => {
    const result = checkSetup({ key: 'eyJnew', resendApiKey: '', emailFrom: 'ads@slash.test' }, null)
    expect(result.ok).toBe(false)
    expect(result.problem).toMatch(/Resend API key/)
  })

  it('refuses a Resend key of the wrong shape', () => {
    const result = checkSetup(
      { key: '', resendApiKey: 'eyJwrong', emailFrom: 'ads@slash.test' },
      stored
    )
    expect(result.ok).toBe(false)
    expect(result.problem).toMatch(/re_/)
  })

  it('accepts a bare address and the display form', () => {
    for (const from of ['ads@slash.test', 'Slash Adverts <ads@slash.test>', 'a@b.co.uk']) {
      expect(checkSetup({ key: '', resendApiKey: 're_x', emailFrom: from }, stored).ok).toBe(true)
    }
  })

  it('refuses an address that could not be sent from', () => {
    for (const from of ['ads', 'ads@slash', 'ads slash.test', '<ads@slash.test', 'a@b.c om']) {
      expect(checkSetup({ key: '', resendApiKey: 're_x', emailFrom: from }, stored).ok).toBe(false)
    }
  })
})

describe('checkSetup — the string form the first version sent', () => {
  it('still means "the service key"', () => {
    expect(checkSetup('eyJbare', null)).toEqual({
      ok: true,
      credentials: { serviceKey: 'eyJbare', resendApiKey: '', emailFrom: '' }
    })
  })
})
