import { supabaseServer } from './supabase/server'
import type { Tier } from '@slash/ad-shared'

/**
 * Operator-controlled configuration, read fresh.
 *
 * Prices are read here rather than baked into the page so that the number an
 * operator types in the admin app is the number a visitor sees and the number
 * Stripe charges — three places that have no business disagreeing.
 */

export interface PlatformSettings {
  currency: string
  minLeadTimeHours: number
  supportEmail: string
  stripeMode: 'test' | 'live'
  stripePublishableKey: string
}

const DEFAULTS: PlatformSettings = {
  currency: 'usd',
  minLeadTimeHours: 12,
  supportEmail: '',
  stripeMode: 'test',
  stripePublishableKey: ''
}

export async function loadSettings(): Promise<PlatformSettings> {
  const supabase = await supabaseServer()
  const { data } = await supabase.from('platform_settings').select('key, value')
  if (!data) return DEFAULTS

  const map = new Map(data.map((row) => [row.key as string, row.value]))
  const str = (key: string, fallback: string): string => {
    const value = map.get(key)
    return typeof value === 'string' && value !== '' ? value : fallback
  }
  const num = (key: string, fallback: number): number => {
    const value = map.get(key)
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  return {
    currency: str('currency', DEFAULTS.currency),
    minLeadTimeHours: num('min_lead_time_hours', DEFAULTS.minLeadTimeHours),
    supportEmail: str('support_email', DEFAULTS.supportEmail),
    stripeMode: str('stripe_mode', 'test') === 'live' ? 'live' : 'test',
    stripePublishableKey: str('stripe_publishable_key', '')
  }
}

interface TierRow {
  placement_tier: string
  display_name: string
  description: string
  hourly_rate: number | string
  min_hours: number
  max_concurrent: number
  active: boolean
}

/** Rates arrive as numeric(10,2); converted to whole cents once, here. */
export function toTier(row: TierRow): Tier & { description: string } {
  return {
    placementTier: row.placement_tier,
    displayName: row.display_name,
    description: row.description,
    hourlyRateCents: Math.round(Number(row.hourly_rate) * 100),
    minHours: row.min_hours,
    maxConcurrent: row.max_concurrent,
    active: row.active
  }
}

export async function loadTiers(): Promise<(Tier & { description: string })[]> {
  const supabase = await supabaseServer()
  const { data } = await supabase
    .from('pricing_config')
    .select('placement_tier, display_name, description, hourly_rate, min_hours, max_concurrent, active')
    .eq('active', true)
    .order('hourly_rate', { ascending: false })

  return (data ?? []).map((row) => toTier(row as TierRow))
}
