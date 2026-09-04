import { describe, expect, it } from 'vitest'
import {
  checkCoinConfig,
  countdownFrom,
  hourlyValueUsd,
  hoursPerCoin,
  toLocalInput,
  MAX_COINS_PER_HOUR,
  MAX_COIN_TO_USD,
  type CoinConfigInput
} from './coin'

const NOW = Date.parse('2026-09-03T12:00:00Z')

const good: CoinConfigInput = {
  earningActive: true,
  coinsPerHour: '10',
  dailyCapHours: '6',
  coinToUsd: '',
  launchAt: '',
  maxAgeDays: '7',
  clockSkewSeconds: '120'
}

const accept = (input: Partial<CoinConfigInput>) => {
  const result = checkCoinConfig({ ...good, ...input }, NOW)
  if (!result.ok) throw new Error(`expected ok, got: ${result.problem}`)
  return result.config
}

const reject = (input: Partial<CoinConfigInput>) => {
  const result = checkCoinConfig({ ...good, ...input }, NOW)
  if (result.ok) throw new Error('expected a refusal')
  return result.problem
}

describe('the coin value, which is a claim about money', () => {
  it('stays null when the field is empty, rather than becoming zero', () => {
    // The whole point of the nullable column: unset renders as "Pending", and
    // zero would tell somebody their coins are worth nothing instead.
    expect(accept({ coinToUsd: '' }).coinToUsd).toBeNull()
    expect(accept({ coinToUsd: '   ' }).coinToUsd).toBeNull()
  })

  it('publishes what was typed', () => {
    expect(accept({ coinToUsd: '0.05' }).coinToUsd).toBe(0.05)
    expect(accept({ coinToUsd: '0.00000001' }).coinToUsd).toBe(0.00000001)
  })

  it('refuses zero, and says how to un-publish instead', () => {
    expect(reject({ coinToUsd: '0' })).toMatch(/Clear the field/)
    expect(reject({ coinToUsd: '-1' })).toMatch(/more than zero/)
  })

  it('refuses a slipped decimal point', () => {
    // 5 where 0.05 was meant is a hundredfold claim, and nothing downstream
    // would question it.
    expect(reject({ coinToUsd: String(MAX_COIN_TO_USD + 1) })).toMatch(/decimal point/)
  })

  it('refuses more precision than the column keeps', () => {
    expect(reject({ coinToUsd: '0.000000001' })).toMatch(/8 decimal places/)
  })

  it('refuses text', () => {
    expect(reject({ coinToUsd: 'five cents' })).toMatch(/number/)
  })
})

describe('the earning rate', () => {
  it('takes fractions, because "a coin every two hours" is one', () => {
    expect(accept({ coinsPerHour: '0.5' }).coinsPerHour).toBe(0.5)
  })

  it('allows zero, which is a rate and not an absence', () => {
    // Distinct from the coin value: 0 coins an hour is a real setting, and the
    // browser says the rate has not been published only when it is 0 anyway.
    expect(accept({ coinsPerHour: '0' }).coinsPerHour).toBe(0)
  })

  it('refuses an empty field', () => {
    // Number('') is 0, which is exactly the coercion that would silently set
    // the rate to nothing.
    expect(reject({ coinsPerHour: '' })).toMatch(/needs a number/)
  })

  it('refuses negatives and absurd rates', () => {
    expect(reject({ coinsPerHour: '-2' })).toMatch(/negative/)
    expect(reject({ coinsPerHour: String(MAX_COINS_PER_HOUR + 1) })).toMatch(/decimal point/)
  })

  it('refuses more precision than the column keeps', () => {
    expect(reject({ coinsPerHour: '1.00001' })).toMatch(/4 decimal places/)
  })
})

describe('the daily maximum', () => {
  it('is entered in hours and stored in seconds', () => {
    expect(accept({ dailyCapHours: '6' }).dailyCapSeconds).toBe(21_600)
    expect(accept({ dailyCapHours: '0.5' }).dailyCapSeconds).toBe(1800)
  })

  it('cannot exceed a day', () => {
    expect(accept({ dailyCapHours: '24' }).dailyCapSeconds).toBe(86_400)
    expect(reject({ dailyCapHours: '25' })).toMatch(/0 and 24/)
    expect(reject({ dailyCapHours: '-1' })).toMatch(/0 and 24/)
  })
})

describe('the anti-abuse figures', () => {
  it('are whole numbers inside the bounds the database checks', () => {
    expect(accept({ maxAgeDays: '30' }).maxAgeDays).toBe(30)
    expect(reject({ maxAgeDays: '0' })).toMatch(/1 to 90/)
    expect(reject({ maxAgeDays: '91' })).toMatch(/1 to 90/)
    expect(reject({ maxAgeDays: '7.5' })).toMatch(/whole number/)

    expect(accept({ clockSkewSeconds: '0' }).clockSkewSeconds).toBe(0)
    expect(reject({ clockSkewSeconds: '3601' })).toMatch(/0 to 3600/)
  })
})

describe('the launch date', () => {
  it('stays null when nothing is set', () => {
    expect(accept({ launchAt: '' }).launchAt).toBeNull()
  })

  it('reads a datetime-local value', () => {
    expect(accept({ launchAt: '2026-12-01T09:30' }).launchAt).toBe(
      Date.parse('2026-12-01T09:30')
    )
  })

  it('allows a date that has passed, because that is a real state', () => {
    expect(accept({ launchAt: '2020-01-01T00:00' }).launchAt).toBe(Date.parse('2020-01-01T00:00'))
  })

  it('refuses a mistyped year', () => {
    expect(reject({ launchAt: '2226-01-01T00:00' })).toMatch(/ten years/)
  })

  it('refuses something that is not a date', () => {
    expect(reject({ launchAt: 'next Tuesday' })).toMatch(/could not be read/)
  })
})

describe('hoursPerCoin — the sentence the browser shows', () => {
  it('picks the unit that makes the number readable', () => {
    expect(hoursPerCoin(10)).toBe('6 minutes')
    expect(hoursPerCoin(1)).toBe('1 hours')
    expect(hoursPerCoin(0.5)).toBe('2 hours')
    expect(hoursPerCoin(60)).toBe('1 minutes')
    expect(hoursPerCoin(120)).toBe('30 seconds')
    expect(hoursPerCoin(40)).toBe('1.5 minutes')
  })

  it('has nothing to say about a rate of nothing', () => {
    expect(hoursPerCoin(0)).toBe('—')
    expect(hoursPerCoin(-1)).toBe('—')
    expect(hoursPerCoin(Number.NaN)).toBe('—')
  })
})

describe('hourlyValueUsd', () => {
  it('multiplies out only when a value has been published', () => {
    expect(hourlyValueUsd(10, 0.05)).toBeCloseTo(0.5, 10)
    expect(hourlyValueUsd(10, null)).toBeNull()
    expect(hourlyValueUsd(0, 0.05)).toBeNull()
  })
})

describe('countdownFrom', () => {
  it('reads in the units the browser uses', () => {
    expect(countdownFrom(NOW + 90_000_000, NOW)).toBe('1d 1h 0m')
    expect(countdownFrom(NOW + 3_660_000, NOW)).toBe('1h 1m')
    expect(countdownFrom(NOW + 120_000, NOW)).toBe('2m')
  })

  it('is nothing at all once the moment has passed', () => {
    expect(countdownFrom(NOW - 1, NOW)).toBeNull()
    expect(countdownFrom(NOW, NOW)).toBeNull()
    expect(countdownFrom(null, NOW)).toBeNull()
  })
})

describe('toLocalInput', () => {
  it('round-trips through the form field', () => {
    const at = Date.parse('2026-12-01T09:30')
    expect(accept({ launchAt: toLocalInput(at) }).launchAt).toBe(at)
  })

  it('is empty for nothing set', () => {
    expect(toLocalInput(null)).toBe('')
  })
})
