/**
 * The Slash Coin settings an operator can change, and what they mean.
 *
 * These are the figures the browser puts on its rewards page: the earning
 * rate, the daily maximum, the published value of a coin and the launch date.
 * Two reasons this is a tested module rather than validation inside a form
 * handler.
 *
 * **A rate is a claim about money.** "$0.05 a coin" published against a
 * balance somebody has been collecting for a month is a number they will
 * quote back. A typo in the box — 5 instead of 0.05 — is a hundredfold claim,
 * and nothing downstream would question it: the column takes eight decimal
 * places and the browser renders whatever it is given.
 *
 * **Unset is not zero.** `coinToUsd` and `launchAt` are nullable in the
 * database on purpose, and null has to survive the whole way through this
 * module to the screen. Zero is a rate — publishing it tells somebody their
 * coins are worth nothing, which is a different statement from "we have not
 * decided yet", and the wrong one. The browser renders null as **Pending**.
 *
 * `hoursPerCoin` is deliberately a second implementation of the browser's own
 * `src/renderer/features/newtab/coinRates.ts`. The two applications share no
 * build, and the operator screen needs to show the same sentence the browser
 * will show — so the wording is pinned by tests on both sides rather than by
 * an import that cannot exist.
 */

/** What the database holds. One row, and every field an operator may set. */
export interface CoinConfig {
  earningActive: boolean
  coinsPerHour: number
  dailyCapSeconds: number
  /** USD per coin, or null when nothing has been published. */
  coinToUsd: number | null
  /** Epoch ms, or null when no launch date has been set. */
  launchAt: number | null
  maxAgeDays: number
  clockSkewSeconds: number
}

/** What the form sends. Everything is a string, because every input is. */
export interface CoinConfigInput {
  earningActive: boolean
  coinsPerHour: string
  dailyCapHours: string
  /** Empty means "publish nothing", which is not the same as "0". */
  coinToUsd: string
  /** A `datetime-local` value, or empty for no launch date. */
  launchAt: string
  maxAgeDays: string
  clockSkewSeconds: string
}

export type CoinCheck =
  | { readonly ok: true; readonly config: CoinConfig }
  | { readonly ok: false; readonly problem: string }

// Bounds. Each is a sanity limit on a typo, not a policy: the database's own
// CHECK constraints are the authority, and these exist so a mistake is caught
// in front of the person who made it rather than as a Postgres error.
export const MAX_COINS_PER_HOUR = 10_000
/** A coin worth more than this is a slipped decimal point, not a valuation. */
export const MAX_COIN_TO_USD = 1_000
export const COIN_TO_USD_DECIMALS = 8
export const COINS_PER_HOUR_DECIMALS = 4

/**
 * Reads one number out of a text field.
 *
 * `Number('')` is 0 and `Number(' ')` is 0, which is exactly the coercion that
 * turns a cleared field into a published rate of zero. Both are refused here.
 */
function parseNumber(raw: string, field: string): number | string {
  const text = raw.trim()
  if (text === '') return `${field} needs a number.`
  const value = Number(text)
  if (!Number.isFinite(value)) return `${field} needs to be a number.`
  return value
}

function decimalsOf(raw: string): number {
  const dot = raw.trim().indexOf('.')
  return dot === -1 ? 0 : raw.trim().length - dot - 1
}

/** How long somebody has to browse to earn one coin, in words. */
export function hoursPerCoin(coinsPerHour: number): string {
  if (!Number.isFinite(coinsPerHour) || coinsPerHour <= 0) return '—'
  const minutes = 60 / coinsPerHour
  if (minutes < 1) return `${Math.round(minutes * 60)} seconds`
  if (minutes < 60) return `${minutes % 1 === 0 ? minutes : minutes.toFixed(1)} minutes`
  const hours = minutes / 60
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)} hours`
}

/** What an hour of browsing is worth, or null while no value is published. */
export function hourlyValueUsd(coinsPerHour: number, coinToUsd: number | null): number | null {
  if (coinToUsd === null || !Number.isFinite(coinsPerHour) || coinsPerHour <= 0) return null
  return coinsPerHour * coinToUsd
}

/**
 * Validates what was typed and returns what to store.
 *
 * `now` is injected so the launch-date rules are testable without waiting for
 * a Tuesday.
 */
export function checkCoinConfig(input: CoinConfigInput, now: number): CoinCheck {
  const coinsPerHour = parseNumber(input.coinsPerHour, 'The earning rate')
  if (typeof coinsPerHour === 'string') return { ok: false, problem: coinsPerHour }
  if (coinsPerHour < 0) return { ok: false, problem: 'The earning rate cannot be negative.' }
  if (coinsPerHour > MAX_COINS_PER_HOUR) {
    return {
      ok: false,
      problem: `${MAX_COINS_PER_HOUR.toLocaleString()} coins an hour is the most this accepts — check the decimal point.`
    }
  }
  if (decimalsOf(input.coinsPerHour) > COINS_PER_HOUR_DECIMALS) {
    return {
      ok: false,
      problem: `The earning rate is stored to ${COINS_PER_HOUR_DECIMALS} decimal places.`
    }
  }

  const dailyCapHours = parseNumber(input.dailyCapHours, 'The daily maximum')
  if (typeof dailyCapHours === 'string') return { ok: false, problem: dailyCapHours }
  if (dailyCapHours < 0 || dailyCapHours > 24) {
    return { ok: false, problem: 'The daily maximum has to be between 0 and 24 hours.' }
  }

  const maxAgeDays = parseNumber(input.maxAgeDays, 'The reporting window')
  if (typeof maxAgeDays === 'string') return { ok: false, problem: maxAgeDays }
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 90) {
    return { ok: false, problem: 'The reporting window has to be a whole number of days, 1 to 90.' }
  }

  const clockSkewSeconds = parseNumber(input.clockSkewSeconds, 'The clock tolerance')
  if (typeof clockSkewSeconds === 'string') return { ok: false, problem: clockSkewSeconds }
  if (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 3600) {
    return {
      ok: false,
      problem: 'The clock tolerance has to be a whole number of seconds, 0 to 3600.'
    }
  }

  // Empty is "publish nothing", and stays null all the way to the browser,
  // which shows it as Pending. It is never coerced to 0.
  let coinToUsd: number | null = null
  if (input.coinToUsd.trim() !== '') {
    const value = parseNumber(input.coinToUsd, 'The coin value')
    if (typeof value === 'string') return { ok: false, problem: value }
    if (value <= 0) {
      return {
        ok: false,
        problem:
          'A published value has to be more than zero. Clear the field to go back to showing "Pending".'
      }
    }
    if (value > MAX_COIN_TO_USD) {
      return {
        ok: false,
        problem: `$${MAX_COIN_TO_USD.toLocaleString()} a coin is the most this accepts — check the decimal point.`
      }
    }
    if (decimalsOf(input.coinToUsd) > COIN_TO_USD_DECIMALS) {
      return {
        ok: false,
        problem: `The coin value is stored to ${COIN_TO_USD_DECIMALS} decimal places.`
      }
    }
    coinToUsd = value
  }

  let launchAt: number | null = null
  if (input.launchAt.trim() !== '') {
    const parsed = Date.parse(input.launchAt)
    if (!Number.isFinite(parsed)) {
      return { ok: false, problem: 'That launch date could not be read.' }
    }
    // A date in the past is allowed: a launch that has happened is a real
    // state, and the browser simply stops counting down. Ten years out is a
    // mistyped year, and a countdown nobody will live to see is not a launch.
    if (parsed > now + TEN_YEARS_MS) {
      return { ok: false, problem: 'That launch date is more than ten years away — check the year.' }
    }
    launchAt = parsed
  }

  return {
    ok: true,
    config: {
      earningActive: input.earningActive,
      coinsPerHour,
      dailyCapSeconds: Math.round(dailyCapHours * 3600),
      coinToUsd,
      launchAt,
      maxAgeDays,
      clockSkewSeconds
    }
  }
}

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000

/**
 * The countdown the browser will draw, in the same units it uses.
 *
 * Here so the operator setting the date sees what a reader will see, rather
 * than a timestamp and a hope. Returns null once the moment has passed, which
 * is what the browser does with it — no countdown, no negative numbers.
 */
export function countdownFrom(launchAt: number | null, now: number): string | null {
  if (launchAt === null) return null
  const remaining = launchAt - now
  if (remaining <= 0) return null

  const days = Math.floor(remaining / 86_400_000)
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000)
  const minutes = Math.floor((remaining % 3_600_000) / 60_000)
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** The `datetime-local` value for a stored timestamp; empty for null. */
export function toLocalInput(launchAt: number | null): string {
  if (launchAt === null) return ''
  const at = new Date(launchAt)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  )
}
