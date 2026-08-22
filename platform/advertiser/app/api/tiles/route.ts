import { NextResponse } from 'next/server'
import {
  BATCH_LOOKAHEAD_MS,
  BATCH_TTL_MS,
  acceptCreative,
  buildBatch,
  capBatchSize,
  toBatchTile,
  type Batch,
  type BatchTile,
  type CampaignRow
} from '@slash/ad-shared'
import { supabaseService } from '@/lib/supabase/service'

/**
 * The batch every copy of Slash downloads.
 *
 * Deliberately identical for every caller. There is no request body, no cookie,
 * no query parameter and no header this varies on — which is what makes the
 * browser's claim true: we learn that a copy of Slash asked for adverts, and
 * nothing whatever about who is running it. Adding a parameter here, for any
 * reason, breaks that.
 *
 * It carries campaigns that have not started yet, with their windows. Each
 * machine starts and stops them on its own clock. That is what lets an advert
 * be sold by the hour when a browser only asks for a new batch every six.
 */

export const dynamic = 'force-dynamic'

/** Roughly 6 MB of base64. Every live image is in the file every reader fetches. */
const MAX_BATCH_BYTES = 6_000_000

/**
 * Built batches, memoised per server instance.
 *
 * Without this, every browser asking triggers a download of every live creative
 * out of storage. The window is short because a campaign starting in the next
 * few minutes should not have to wait for a cache to lapse.
 */
let cached: { at: number; batch: Batch } | null = null
const CACHE_MS = 60_000

export async function GET(): Promise<NextResponse> {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_MS) {
    return json(cached.batch)
  }

  try {
    const supabase = supabaseService()

    // Campaigns already running, plus everything starting before this reader is
    // due to ask again. A machine that misses one refresh must still be holding
    // what starts before the next.
    const { data, error } = await supabase
      .from('campaigns')
      .select(
        'id, title, description, destination_link, image_path, starts_at, ends_at, ' +
          'advertisers ( company_name )'
      )
      .in('status', ['scheduled', 'active'])
      .gt('ends_at', new Date(now).toISOString())
      .lt('starts_at', new Date(now + BATCH_LOOKAHEAD_MS).toISOString())
      .order('starts_at', { ascending: true })

    if (error) throw error

    const tiles: BatchTile[] = []
    for (const row of data ?? []) {
      const campaign = row as unknown as CampaignRow & { image_path: string | null }
      const image = await inlineImage(supabase, campaign.image_path)
      const tile = toBatchTile(campaign, image)

      // The same rules the browser applies. Refused here too, so a creative
      // that would be silently dropped by every reader is instead visible as
      // missing from the batch, where somebody can notice it.
      const verdict = acceptCreative(tile)
      if (!verdict.ok) {
        console.warn(`campaign ${tile.id} left out of the batch: ${verdict.reason}`)
        continue
      }
      tiles.push(tile)
    }

    const { kept, dropped } = capBatchSize(tiles, MAX_BATCH_BYTES)
    if (dropped.length > 0) {
      console.warn(
        `batch over ${MAX_BATCH_BYTES} bytes; ${dropped.length} campaign(s) held back: ` +
          dropped.map((tile) => tile.id).join(', ')
      )
    }

    const batch = buildBatch(kept, now)
    cached = { at: now, batch }
    return json(batch)
  } catch (cause) {
    console.error('could not build the sponsor batch', cause)
    // An empty batch, not a 500. The browser treats a malformed or failed
    // response by keeping whatever it already has until that expires — but an
    // empty, well-formed batch is the honest answer to "what should I show?"
    // when we cannot tell, and it costs a reader nothing.
    return json(buildBatch([], now))
  }
}

function json(batch: Batch): NextResponse {
  return NextResponse.json(batch, {
    headers: {
      'cache-control': `public, max-age=${Math.floor(BATCH_TTL_MS / 4000)}`,
      // No cookie may ever be set on this response. One would turn an
      // anonymous batch request into a way of recognising the same machine
      // twice, which is the entire thing this design exists to avoid.
      'set-cookie': ''
    }
  })
}

/**
 * Reads a creative out of the private bucket and inlines it as a data URL.
 *
 * Inlined rather than linked because a remote `<img src>` would be a request to
 * us every single time the advert appeared, on every machine running it — a
 * tracking pixel by another name. The browser refuses any creative whose image
 * is not a data URL, so this is not an optimisation; it is the only shape that
 * gets delivered at all.
 */
async function inlineImage(
  supabase: ReturnType<typeof supabaseService>,
  path: string | null
): Promise<string> {
  if (!path) return ''
  try {
    const { data, error } = await supabase.storage.from('campaign-assets').download(path)
    if (error || !data) return ''
    const buffer = Buffer.from(await data.arrayBuffer())
    const type = data.type && data.type.startsWith('image/') ? data.type : 'image/png'
    return `data:${type};base64,${buffer.toString('base64')}`
  } catch (cause) {
    console.warn(`could not inline creative ${path}`, cause)
    return ''
  }
}
