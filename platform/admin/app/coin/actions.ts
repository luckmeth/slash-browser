'use server'

import { revalidatePath } from 'next/cache'
import { checkCoinConfig, type CoinConfigInput } from '@slash/ad-shared'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export type CoinSaveResult = { error: string } | { ok: string } | undefined

/**
 * Writes the one row of `coin_config`.
 *
 * Every figure here reaches the browser through `coin_state()` and is rendered
 * on the rewards page, so this handler is the last point at which a typo is
 * still a typo rather than a published claim. The decision is made by
 * `checkCoinConfig`, which is pure and tested in `platform/shared`, because
 * "the box was empty" has to mean two different things in one form: an empty
 * coin value un-publishes it, and an empty earning rate is a mistake.
 *
 * The row is addressed by its own primary key (`id = true`), which is how a
 * single-row table is written without an `update ... where true` that a
 * missing filter would turn into "every row".
 */
export async function saveCoinConfig(
  _previous: CoinSaveResult,
  formData: FormData
): Promise<CoinSaveResult> {
  const admin = await currentAdmin()
  if (!admin) return { error: 'Not an operator.' }

  const input: CoinConfigInput = {
    // An unchecked checkbox sends nothing at all, which is the whole reason
    // this reads presence rather than a value.
    earningActive: formData.get('earningActive') !== null,
    coinsPerHour: String(formData.get('coinsPerHour') ?? ''),
    dailyCapHours: String(formData.get('dailyCapHours') ?? ''),
    coinToUsd: String(formData.get('coinToUsd') ?? ''),
    launchAt: String(formData.get('launchAt') ?? ''),
    maxAgeDays: String(formData.get('maxAgeDays') ?? ''),
    clockSkewSeconds: String(formData.get('clockSkewSeconds') ?? '')
  }

  const verdict = checkCoinConfig(input, Date.now())
  if (!verdict.ok) return { error: verdict.problem }
  const config = verdict.config

  const { error } = await supabaseService()
    .from('coin_config')
    .update({
      earning_active: config.earningActive,
      coins_per_hour: config.coinsPerHour,
      daily_cap_seconds: config.dailyCapSeconds,
      // Null, not zero. The column is nullable so that "nobody has decided
      // yet" survives all the way to the browser, which shows it as Pending.
      coin_to_usd: config.coinToUsd,
      launch_at: config.launchAt === null ? null : new Date(config.launchAt).toISOString(),
      max_age_days: config.maxAgeDays,
      clock_skew_seconds: config.clockSkewSeconds,
      updated_by: admin.authUserId,
      updated_at: new Date().toISOString()
    })
    .eq('id', true)

  if (error) {
    // The pause switch and the two published rates arrived in a later
    // migration than the table. A deployment that has not run it gets a
    // column-not-found error, which is worth naming rather than showing raw.
    if (/column .* does not exist|earning_active|coin_to_usd|launch_at/i.test(error.message)) {
      return {
        error:
          'The database is missing the coin control columns. Apply ' +
          'supabase/migrations/20260903_coin_controls.sql, then save again. ' +
          `(${error.message})`
      }
    }
    return { error: error.message }
  }

  revalidatePath('/coin')
  return {
    ok: config.earningActive
      ? 'Saved. Browsers pick this up on their next check.'
      : 'Saved. Earning is paused — nothing is accruing for anyone.'
  }
}
