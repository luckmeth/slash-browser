import { describe, expect, it } from 'vitest'
import { checkCallback, codeFromRedirect, extractCode } from './callbackCheck'

const expectedState = 'nS6bQ2wR8vTx0LkMjYpZaEcD'

describe('checkCallback', () => {
  it('accepts the callback Supabase actually sends: a code and no state', () => {
    // Measured against the live endpoint. Supabase keeps its own state for the
    // Google leg and returns `?code=` alone, so demanding a state here would
    // reject every genuine sign-in.
    expect(checkCallback({ code: 'abc123', state: '', expectedState })).toEqual({ accept: true })
  })

  it('accepts a matching state when one is present', () => {
    expect(checkCallback({ code: 'abc123', state: expectedState, expectedState })).toEqual({
      accept: true
    })
  })

  it('refuses a state that is present and wrong', () => {
    expect(checkCallback({ code: 'abc123', state: 'not-the-one', expectedState })).toEqual({
      accept: false,
      reason: 'state-mismatch'
    })
  })

  it('refuses a wrong state of exactly the right length', () => {
    // The length check is a guard for `timingSafeEqual`, not the comparison
    // itself — a same-length impostor must still fail.
    const impostor = 'X'.repeat(expectedState.length)
    expect(impostor).toHaveLength(expectedState.length)
    expect(checkCallback({ code: 'abc123', state: impostor, expectedState })).toEqual({
      accept: false,
      reason: 'state-mismatch'
    })
  })

  it('refuses a callback with no code, however good the state is', () => {
    // Google redirects here with `?error=access_denied` when somebody presses
    // cancel. There is nothing to exchange.
    expect(checkCallback({ code: '', state: expectedState, expectedState })).toEqual({
      accept: false,
      reason: 'no-code'
    })
  })

  it('refuses an empty callback', () => {
    expect(checkCallback({ code: '', state: '', expectedState })).toEqual({
      accept: false,
      reason: 'no-code'
    })
  })

  it('does not throw on multibyte input', () => {
    // The byte length and the character length differ here, which is exactly
    // what makes `timingSafeEqual` throw if the lengths are not checked first.
    expect(() =>
      checkCallback({ code: 'abc', state: 'ünïcødé', expectedState })
    ).not.toThrow()
    expect(checkCallback({ code: 'abc', state: 'ünïcødé', expectedState }).accept).toBe(false)
  })
})

describe('extractCode', () => {
  it('reads a code from the loopback callback', () => {
    expect(extractCode('http://127.0.0.1:59726/callback?code=abc123def456')).toBe('abc123def456')
  })

  it('reads a code from the site_url fallback, where it lands in the fragment', () => {
    // This is the exact address somebody is looking at when the loopback was
    // never reached, so it is the case the whole fallback exists for.
    expect(extractCode('http://localhost:3000/#code=abc123def456')).toBe('abc123def456')
  })

  it('reads a code alongside other parameters', () => {
    expect(extractCode('http://localhost:3000/?state=xyz&code=abc123def456&x=1')).toBe(
      'abc123def456'
    )
  })

  it('accepts a bare code pasted on its own', () => {
    expect(extractCode('  abc123def456ghi789  ')).toBe('abc123def456ghi789')
  })

  it('refuses an implicit-flow access token', () => {
    // A live credential, not a code. Sending it to the token endpoint as if it
    // were one would be both wrong and careless with a secret.
    expect(extractCode('http://localhost:3000#access_token=eyJhbGciOi.abc.def&type=magiclink')).toBe(
      ''
    )
  })

  it('refuses text that is not a code', () => {
    expect(extractCode('')).toBe('')
    expect(extractCode('   ')).toBe('')
    expect(extractCode('it did not work')).toBe('')
    expect(extractCode('http://localhost:3000/')).toBe('')
    expect(extractCode('me@example.com')).toBe('')
  })

  it('refuses a bare string too short to be a code', () => {
    expect(extractCode('abc123')).toBe('')
  })
})

describe('codeFromRedirect', () => {
  const provider = 'https://edsuuwzihojdsmgzhzyw.supabase.co'

  it('takes the code from the loopback redirect', () => {
    expect(
      codeFromRedirect('http://127.0.0.1:59949/callback?code=abc123def456', provider)
    ).toBe('abc123def456')
  })

  it('takes the code from the site_url fallback, which is the failing case', () => {
    expect(codeFromRedirect('http://localhost:3000/?code=abc123def456', provider)).toBe(
      'abc123def456'
    )
  })

  it("ignores Google's code on its way to the auth service", () => {
    // This hop also carries `?code=`, and consuming it would abort the real
    // sign-in one step before the code we actually want.
    expect(
      codeFromRedirect(
        'https://edsuuwzihojdsmgzhzyw.supabase.co/auth/v1/callback?code=googles-code&state=x',
        provider
      )
    ).toBe('')
  })

  it('ignores Google itself', () => {
    expect(
      codeFromRedirect('https://accounts.google.com/o/oauth2/v2/auth?code=nope', provider)
    ).toBe('')
    expect(codeFromRedirect('https://google.com/?code=nope', provider)).toBe('')
  })

  it('is not fooled by a lookalike host', () => {
    expect(
      codeFromRedirect('https://accounts.google.com.evil.example/?code=abc123def456', provider)
    ).toBe('abc123def456')
    expect(
      codeFromRedirect('https://notsupabase.co/?code=abc123def456', provider)
    ).toBe('abc123def456')
  })

  it('refuses everything when the provider address is unusable', () => {
    // Without a host to exclude there is no safe answer, and guessing would
    // mean handing the provider's own code to the exchange.
    expect(codeFromRedirect('http://localhost:3000/?code=abc123def456', '')).toBe('')
  })

  it('ignores a redirect with no code at all', () => {
    expect(codeFromRedirect('http://localhost:3000/', provider)).toBe('')
    expect(codeFromRedirect('not a url', provider)).toBe('')
  })
})
