import { describe, expect, it } from 'vitest'
import type { CoinProfileInput } from './types/rewards'
import {
  ageOn,
  checkProfile,
  profileComplete,
  walletLooksValid,
  MINIMUM_AGE_YEARS
} from './profileRules'

const NOW = Date.parse('2026-09-03T12:00:00Z')

const good: CoinProfileInput = {
  fullName: 'Ada Lovelace',
  dateOfBirth: '1990-05-04',
  addressLine1: '12 Hill Street',
  addressLine2: '',
  city: 'Colombo',
  region: 'Western',
  postcode: '00100',
  country: 'LK',
  phone: '+94 77 123 4567',
  walletAddress: '',
  walletNetwork: '',
  emailOptOut: false
}

const problems = (input: Partial<CoinProfileInput>): string[] =>
  checkProfile({ ...good, ...input }, NOW).map((entry) => entry.field)

describe('a complete profile', () => {
  it('passes with no wallet at all', () => {
    // Deliberate: the rest is worth saving before somebody has a wallet, and
    // nothing is being paid out yet.
    expect(checkProfile(good, NOW)).toEqual([])
    expect(profileComplete(good, NOW)).toBe(true)
  })

  it('passes with a wallet', () => {
    expect(
      profileComplete(
        {
          ...good,
          walletNetwork: 'ethereum',
          walletAddress: '0x52908400098527886E0F7030069857D2E4169EE7'
        },
        NOW
      )
    ).toBe(true)
  })
})

describe('the required fields', () => {
  it('names every problem at once, not the first', () => {
    // A form that reveals one mistake per submission is a form people abandon.
    const found = problems({ fullName: '', city: '', phone: '' })
    expect(found).toEqual(['fullName', 'city', 'phone'])
  })

  it('wants a name, an address, a city, a country and a phone number', () => {
    expect(problems({ fullName: '   ' })).toContain('fullName')
    expect(problems({ addressLine1: '' })).toContain('addressLine1')
    expect(problems({ city: '' })).toContain('city')
    expect(problems({ country: '' })).toContain('country')
    expect(problems({ phone: '' })).toContain('phone')
  })

  it('does not require the optional lines', () => {
    expect(problems({ addressLine2: '', region: '', postcode: '' })).toEqual([])
  })

  it('wants a country code, not a country name', () => {
    expect(problems({ country: 'Sri Lanka' })).toContain('country')
    expect(problems({ country: 'lk' })).toEqual([])
  })

  it('refuses letters in a phone number', () => {
    expect(problems({ phone: 'call me' })).toContain('phone')
    expect(problems({ phone: '+94 (77) 123-4567' })).toEqual([])
  })
})

describe('age', () => {
  it('counts whole years, and knows a birthday has not happened yet', () => {
    expect(ageOn('1990-09-03', NOW)).toBe(36)
    expect(ageOn('1990-09-04', NOW)).toBe(35)
    expect(ageOn('1990-09-02', NOW)).toBe(36)
  })

  it('refuses under-eighteens, saying so', () => {
    const under = checkProfile({ ...good, dateOfBirth: '2020-01-01' }, NOW)
    expect(under[0]?.field).toBe('dateOfBirth')
    expect(under[0]?.problem).toContain(String(MINIMUM_AGE_YEARS))
  })

  it('accepts somebody who turned eighteen today', () => {
    expect(problems({ dateOfBirth: '2008-09-03' })).toEqual([])
    expect(problems({ dateOfBirth: '2008-09-04' })).toContain('dateOfBirth')
  })

  it('refuses the future and the implausible', () => {
    expect(problems({ dateOfBirth: '2030-01-01' })).toContain('dateOfBirth')
    expect(problems({ dateOfBirth: '1850-01-01' })).toContain('dateOfBirth')
    expect(problems({ dateOfBirth: 'yesterday' })).toContain('dateOfBirth')
  })
})

describe('the wallet, where a payout would go', () => {
  it('accepts an Ethereum address on the three chains that share the format', () => {
    const address = '0x52908400098527886E0F7030069857D2E4169EE7'
    for (const network of ['ethereum', 'polygon', 'bsc']) {
      expect(walletLooksValid(network, address)).toBe(true)
    }
  })

  it('refuses a truncated paste, which is how a payout is lost to a typo', () => {
    expect(walletLooksValid('ethereum', '0x52908400098527886E0F7030069857D2E4169E')).toBe(false)
    expect(walletLooksValid('ethereum', '0x')).toBe(false)
  })

  it('refuses an address filed under the wrong chain', () => {
    // The check that matters: these are both real addresses, and sending to
    // one on the other network loses the money.
    expect(walletLooksValid('ethereum', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(false)
    expect(walletLooksValid('solana', '0x52908400098527886E0F7030069857D2E4169EE7')).toBe(false)
  })

  it('accepts Solana, Tron and both Bitcoin forms', () => {
    expect(walletLooksValid('solana', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(true)
    expect(walletLooksValid('tron', 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE')).toBe(true)
    expect(walletLooksValid('bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true)
    expect(walletLooksValid('bitcoin', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true)
    expect(walletLooksValid('bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true)
  })

  it('refuses base58 that contains the characters base58 exists to avoid', () => {
    // 0, O, I and l are excluded so an address read aloud cannot become a
    // different valid one.
    expect(walletLooksValid('tron', 'TQn9Y2khEsLJW1ChVWFMSMeRDOw5KcbLS0')).toBe(false)
  })

  it('refuses a network nobody can pay out on', () => {
    expect(walletLooksValid('dogecoin', 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L')).toBe(false)
    expect(problems({ walletNetwork: 'dogecoin', walletAddress: 'x' })).toContain('walletNetwork')
  })

  it('refuses half a pair, in either direction', () => {
    expect(problems({ walletAddress: '0x52908400098527886E0F7030069857D2E4169EE7' })).toContain(
      'walletNetwork'
    )
    expect(problems({ walletNetwork: 'ethereum' })).toContain('walletAddress')
  })

  it('says which chain it expected, because that is the recoverable mistake', () => {
    const found = checkProfile(
      { ...good, walletNetwork: 'solana', walletAddress: '0x52908400098527886E0F7030069857D2E4169EE7' },
      NOW
    )
    expect(found[0]?.problem).toContain('Solana')
    expect(found[0]?.problem).toContain('cannot be undone')
  })
})
