/**
 * The cheapest rate on the card, for the "from $X an hour" line in the hero.
 *
 * Derived from the served rate strings rather than held as a second number, so
 * the headline claim cannot drift out of step with the table underneath it —
 * an operator editing the rate card in the admin application changes both at
 * once or neither.
 *
 * Only the **first** number in each string is considered: these read
 * "$2.50 / hour · 24 hour minimum", and the 24 is a minimum, not a price.
 * Anything unparseable, and anything at zero, is ignored rather than treated as
 * the cheapest — "from $0 an hour" is a claim nobody means to make.
 */
export function lowestRate(placements: readonly { rate: string }[]): string {
  const numbers = placements
    .map((placement) => /([\d]+(?:\.[\d]+)?)/.exec(placement.rate)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
  if (numbers.length === 0) return '—'
  const lowest = Math.min(...numbers)
  return Number.isInteger(lowest) ? String(lowest) : lowest.toFixed(2)
}
