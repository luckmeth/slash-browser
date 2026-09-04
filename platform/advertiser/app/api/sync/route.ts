import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

/**
 * Reference sync server.
 *
 * Stores ciphertext for a signed-in account and hands it back. It cannot read
 * any of it — the browser encrypts on the device with a key derived from a
 * passphrase that never leaves it. That is the point, and it is also why this
 * endpoint is so small: there is nothing here to be clever about.
 *
 * The protocol is documented in the browser repository at `docs/sync.md`. Any
 * server implementing it works; this one exists so there is something to point
 * at rather than a specification nobody has run.
 */

export const dynamic = 'force-dynamic'

const ItemSchema = z.object({
  id: z.string().min(1).max(2048),
  collection: z.enum(['bookmarks', 'reading']),
  updatedAt: z.number(),
  deleted: z.boolean(),
  payload: z.string().max(200_000)
})

const PushSchema = z.object({
  device: z.string().max(100),
  salt: z.string().max(64),
  verifier: z.string().max(128),
  items: z.array(ItemSchema).max(2000)
})

/**
 * The caller's Supabase client, built from their bearer token.
 *
 * Deliberately **not** the service role. Every query below runs as the account
 * that made the request, under the row-level security in `0006_sync.sql` — so a
 * mistake in this file cannot hand one person another person's blobs. With the
 * service role, the RLS policies would be decoration.
 */
function clientFor(request: Request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (token === '') return null
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

/** Finds or creates this user's sync account, and returns it with its salt. */
async function account(supabase: NonNullable<ReturnType<typeof clientFor>>) {
  const {
    data: { user }
  } = await supabase.auth.getUser()
  if (!user) return null

  const existing = await supabase
    .from('sync_accounts')
    .select('id, salt, verifier')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  if (existing.data) return existing.data

  const created = await supabase
    .from('sync_accounts')
    .insert({ auth_user_id: user.id })
    .select('id, salt, verifier')
    .single()
  return created.data ?? null
}

export async function GET(request: Request): Promise<NextResponse> {
  const supabase = clientFor(request)
  if (!supabase) return NextResponse.json({ error: 'sign in required' }, { status: 401 })

  const acct = await account(supabase)
  if (!acct) return NextResponse.json({ error: 'sign in required' }, { status: 401 })

  const since = Number(new URL(request.url).searchParams.get('since') ?? 0)

  const { data, error } = await supabase
    .from('sync_items')
    .select('collection, item_id, updated_at, deleted, payload')
    .eq('account_id', acct.id)
    .gt('updated_at', Number.isFinite(since) ? since : 0)
    .order('updated_at', { ascending: true })
    .limit(5000)

  if (error) {
    console.error('sync pull failed', error)
    return NextResponse.json({ error: 'could not read' }, { status: 503 })
  }

  const items = (data ?? []).map((row) => ({
    id: row.item_id,
    collection: row.collection,
    updatedAt: Number(row.updated_at),
    deleted: row.deleted,
    payload: row.payload
  }))

  return NextResponse.json(
    {
      cursor: items.reduce((highest, item) => Math.max(highest, item.updatedAt), since || 0),
      salt: acct.salt,
      verifier: acct.verifier,
      items
    },
    { headers: { 'cache-control': 'no-store' } }
  )
}

export async function POST(request: Request): Promise<NextResponse> {
  const supabase = clientFor(request)
  if (!supabase) return NextResponse.json({ error: 'sign in required' }, { status: 401 })

  const acct = await account(supabase)
  if (!acct) return NextResponse.json({ error: 'sign in required' }, { status: 401 })

  const parsed = PushSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'malformed' }, { status: 400 })
  }

  // Written once, by whichever device gets here first, and never overwritten.
  // Replacing a salt would strand every device already deriving its key from
  // the old one — their data would still be there and permanently unreadable.
  if (acct.salt === '' && parsed.data.salt !== '') {
    await supabase
      .from('sync_accounts')
      .update({ salt: parsed.data.salt, verifier: parsed.data.verifier })
      .eq('id', acct.id)
      .eq('salt', '')
  }

  const { error } = await supabase.rpc('sync_push', {
    account: acct.id,
    entries: parsed.data.items
  })

  if (error) {
    console.error('sync push failed', error)
    return NextResponse.json({ error: 'could not write' }, { status: 503 })
  }

  return NextResponse.json({ ok: true })
}
