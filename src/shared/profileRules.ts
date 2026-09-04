import type { CoinProfileInput } from './types/rewards'

/**
 * What a collector has to tell us before a payout could be sent, and what
 * counts as an answer.
 *
 * This is the first personal data the browser stores about the person using
 * it, so two things are worth stating plainly in the code that gathers it.
 *
 * **Nothing here is collected unless somebody signs in to Slash Coin and fills
 * the form in.** It is not read from the machine, not inferred, and not
 * required to browse — principle 2 is that nothing leaves the machine unless
 * the user turned it on, and this is as opted-in as a feature gets.
 *
 * **A well-formed wallet address is not a verified one.** The checks below are
 * shape checks: they catch a truncated paste and a Solana address in an
 * Ethereum field, which are the two ways somebody loses a payout to a typo.
 * They are not proof that the person controls the address, and no amount of
 * validation could be — which is why `wallet_verified_at` exists in the
 * database and stays null.
 *
 * Pure and clock-injected, like every other rule in this directory, so the age
 * check is testable without waiting for a birthday.
 */

export type ProfileProblem = { field: keyof CoinProfileInput; problem: string }

/**
 * The minimum age to collect.
 *
 * Eighteen because this scheme is meant to end in a payout to a wallet, and
 * every jurisdiction that has an opinion about paying people has one about
 * paying children. It is stated here rather than assumed, so that changing it
 * is a decision somebody makes in one place.
 */
export const MINIMUM_AGE_YEARS = 18

export const WALLET_NETWORKS = [
  'ethereum',
  'polygon',
  'bsc',
  'solana',
  'tron',
  'bitcoin'
] as const

export type WalletNetwork = (typeof WALLET_NETWORKS)[number]

export const WALLET_NETWORK_LABELS: Record<WalletNetwork, string> = {
  ethereum: 'Ethereum',
  polygon: 'Polygon',
  bsc: 'BNB Smart Chain',
  solana: 'Solana',
  tron: 'Tron',
  bitcoin: 'Bitcoin'
}

const HEX = /^0x[0-9a-fA-F]{40}$/
// Base58 excludes 0, O, I and l precisely so that a human reading one aloud
// cannot produce a different valid string.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/
const BECH32 = /^(bc1)[02-9ac-hj-np-z]{11,71}$/

/** Whether an address is the right shape for the network it was filed under. */
export function walletLooksValid(network: string, address: string): boolean {
  const value = address.trim()
  if (value === '') return false

  switch (network) {
    // One address format, three chains. Filing an address under the wrong one
    // of these is survivable; filing a Solana address here is not.
    case 'ethereum':
    case 'polygon':
    case 'bsc':
      return HEX.test(value)
    case 'solana':
      return value.length >= 32 && value.length <= 44 && BASE58.test(value)
    case 'tron':
      return value.length === 34 && value.startsWith('T') && BASE58.test(value)
    case 'bitcoin':
      return (
        BECH32.test(value.toLowerCase()) ||
        ((value.startsWith('1') || value.startsWith('3')) &&
          value.length >= 26 &&
          value.length <= 35 &&
          BASE58.test(value))
      )
    default:
      return false
  }
}

/** Whole years between a date of birth and now. */
export function ageOn(dateOfBirth: string, now: number): number | null {
  const born = Date.parse(`${dateOfBirth}T00:00:00Z`)
  if (!Number.isFinite(born)) return null

  const at = new Date(now)
  const birth = new Date(born)
  let years = at.getUTCFullYear() - birth.getUTCFullYear()
  const monthDiff = at.getUTCMonth() - birth.getUTCMonth()
  // Not yet had this year's birthday.
  if (monthDiff < 0 || (monthDiff === 0 && at.getUTCDate() < birth.getUTCDate())) years -= 1
  return years
}

/**
 * Every problem with a profile, in field order.
 *
 * All of them at once rather than the first: a form that reveals one mistake
 * per submission is a form people abandon, and this one is eight fields long.
 * An empty list means it may be saved.
 *
 * The wallet is the one part that is optional as a pair — somebody may finish
 * the rest and come back to it — but half of a pair is refused, because an
 * address with no network is unusable and a network with no address is
 * nothing.
 */
export function checkProfile(input: CoinProfileInput, now: number): ProfileProblem[] {
  const problems: ProfileProblem[] = []
  const trimmed = (value: string): string => value.trim()

  const name = trimmed(input.fullName)
  if (name === '') {
    problems.push({ field: 'fullName', problem: 'Your name is needed.' })
  } else if (name.length < 2 || name.length > 120) {
    problems.push({ field: 'fullName', problem: 'That name looks too short or too long.' })
  }

  const dob = trimmed(input.dateOfBirth)
  if (dob === '') {
    problems.push({ field: 'dateOfBirth', problem: 'A date of birth is needed.' })
  } else {
    const age = ageOn(dob, now)
    if (age === null) {
      problems.push({ field: 'dateOfBirth', problem: 'That date could not be read.' })
    } else if (age < 0) {
      problems.push({ field: 'dateOfBirth', problem: 'That date is in the future.' })
    } else if (age < MINIMUM_AGE_YEARS) {
      problems.push({
        field: 'dateOfBirth',
        problem: `Slash Coin is for people aged ${MINIMUM_AGE_YEARS} and over.`
      })
    } else if (age > 120) {
      problems.push({ field: 'dateOfBirth', problem: 'Check the year on that date.' })
    }
  }

  if (trimmed(input.addressLine1) === '') {
    problems.push({ field: 'addressLine1', problem: 'A street address is needed.' })
  }
  if (trimmed(input.city) === '') {
    problems.push({ field: 'city', problem: 'A town or city is needed.' })
  }
  if (!/^[A-Za-z]{2}$/.test(trimmed(input.country))) {
    problems.push({ field: 'country', problem: 'Choose a country.' })
  }

  const phone = trimmed(input.phone)
  if (phone === '') {
    problems.push({ field: 'phone', problem: 'A phone number is needed.' })
  } else if (!/^\+?[0-9 ()-]{6,32}$/.test(phone)) {
    problems.push({
      field: 'phone',
      problem: 'A phone number is digits, and may start with +. No letters.'
    })
  }

  const wallet = trimmed(input.walletAddress)
  const network = trimmed(input.walletNetwork)
  if (wallet === '' && network === '') {
    // Deliberately allowed: the rest of the profile is worth saving before
    // somebody has set a wallet up, and nothing is being paid out yet.
  } else if (wallet === '') {
    problems.push({ field: 'walletAddress', problem: 'Add the wallet address, or clear the network.' })
  } else if (network === '') {
    problems.push({ field: 'walletNetwork', problem: 'Choose which network this address is on.' })
  } else if (!WALLET_NETWORKS.includes(network as WalletNetwork)) {
    problems.push({ field: 'walletNetwork', problem: 'That network is not one we can pay out on.' })
  } else if (!walletLooksValid(network, wallet)) {
    problems.push({
      field: 'walletAddress',
      problem: `That does not look like a ${WALLET_NETWORK_LABELS[network as WalletNetwork]} address. Check it against your wallet — a payout to a wrong address cannot be undone.`
    })
  }

  return problems
}

/** Whether every required field is answered. */
export function profileComplete(input: CoinProfileInput, now: number): boolean {
  return checkProfile(input, now).length === 0
}
