import { NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseService } from '@/lib/supabase/service'

/**
 * Aggregate delivery counts, posted back by each browser.
 *
 * Per campaign, per day. That is the whole of what arrives, so it is the whole
 * of what can be recorded — there is deliberately no timestamp finer than a
 * date, no page, no session and no identifier. The difference between "this
 * creative was seen forty times" and a record of when somebody opened a tab is
 * exactly this schema.
 *
 * Unauthenticated on purpose: requiring a key would mean every copy of Slash
 * carried one, and a per-installation key is an identifier. The cost is that
 * counts are only as trustworthy as the anonymous internet, which is why they
 * are shown to advertisers as indicative and never invoiced from. **Hours live
 * is what is billed** — it is time, and time is verifiable.
 */

export const dynamic = 'force-dynamic'

const ReportSchema = z.object({
  counts: z
    .array(
      z.object({
        tileId: z.string().uuid(),
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        impressions: z.number().int().min(0).max(1_000_000),
        clicks: z.number().int().min(0).max(1_000_000)
      })
    )
    .max(500)
})

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'not json' }, { status: 400 })
  }

  const parsed = ReportSchema.safeParse(body)
  if (!parsed.success) {
    // A 400 rather than a silent 200: the browser keeps counts it could not
    // deliver and retries, so telling it the truth is what gets them here
    // eventually rather than losing them.
    return NextResponse.json({ ok: false, error: 'malformed report' }, { status: 400 })
  }

  try {
    // record_delivery skips ids that name no campaign rather than inserting
    // them — they would be delivery figures for something nobody served.
    const { error } = await supabaseService().rpc('record_delivery', {
      entries: parsed.data.counts.map((entry) => ({
        campaignId: entry.tileId,
        day: entry.day,
        impressions: entry.impressions,
        clicks: entry.clicks
      }))
    })
    if (error) throw error
  } catch (cause) {
    console.error('could not record delivery counts', cause)
    // 503, not 200. The browser only deletes its counts once we accept them,
    // so a lie here loses an advertiser's delivery figures permanently.
    return NextResponse.json({ ok: false }, { status: 503 })
  }

  return NextResponse.json({ ok: true })
}
