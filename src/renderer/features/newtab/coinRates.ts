/**
 * How long somebody has to browse to earn one coin.
 *
 * Shown beside the balance, so it is a statement about the earning rate rather
 * than a formatting nicety — "1.5 hours a coin" and "90 minutes a coin" are the
 * same fact, but "0.0250 hours" tells nobody anything. The unit is chosen to
 * keep the number readable, which is the whole job.
 */
export function hoursPerCoin(coinsPerHour: number): string {
  if (!Number.isFinite(coinsPerHour) || coinsPerHour <= 0) return '—'
  const minutes = 60 / coinsPerHour
  if (minutes < 1) return `${Math.round(minutes * 60)} seconds`
  if (minutes < 60) return `${minutes % 1 === 0 ? minutes : minutes.toFixed(1)} minutes`
  const hours = minutes / 60
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)} hours`
}
