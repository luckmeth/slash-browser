-- ---------------------------------------------------------------------------
-- THE UPDATE FEED, PAYOUT REQUESTS, AND PROVING A WALLET
--
-- Three things, all of which were "wired but unreachable" before this.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The update feed, readable by a browser that has not signed in.
--
-- `releases` was admin-only, so the feed it backs could only be served by the
-- advertiser app — which has to be deployed somewhere for that to be true, and
-- is not. A browser therefore had nothing to check, which is why the updater
-- has never once run for a real user.
--
-- Published releases are public information by definition: the whole point is
-- that every copy of Slash can read them. Unpublished ones stay invisible, so
-- pulling a bad release still takes it out of circulation immediately.
--
-- Deliberately identical for every caller. No cookie, no parameter beyond the
-- channel, nothing to vary on — an update check must not become a way of
-- counting installations.
-- ---------------------------------------------------------------------------

drop policy if exists releases_public_read on releases;
create policy releases_public_read on releases
  for select to anon, authenticated
  using (published);

grant select on releases to anon;

-- ---------------------------------------------------------------------------
-- 2. Payout requests.
--
-- Wallets have been collected for a while and nothing could be done with one:
-- there was no way for somebody to ask to be paid, and no queue for an
-- operator to work through. This is that queue.
--
-- **Requesting deducts.** The coins leave `coin_balances` the moment a request
-- is made, and come back if it is rejected. A balance that still shows coins
-- already claimed is a balance somebody will claim twice, and the second claim
-- is the one that gets paid by accident.
--
-- **The rate is frozen at request time.** `coin_to_usd` moves; what somebody
-- asked to be paid does not. The row records the rate it was asked at, so an
-- operator paying a fortnight later pays what was agreed.
--
-- **Nothing here sends money.** There is no payment rail in this project. A
-- request is marked paid by a person who has sent it, with a reference they
-- paste in, and that is the honest shape of it until there is one.
-- ---------------------------------------------------------------------------

create table if not exists payout_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  coins         numeric(20, 4) not null check (coins > 0),
  -- The published rate when it was asked for, and the money that implies.
  coin_to_usd   numeric(20, 8),
  amount_usd    numeric(20, 2),
  wallet_address text not null,
  wallet_network text not null,
  -- Whether anything had verified the address at the time of asking. Recorded
  -- rather than checked here, so an operator sees what they are deciding on.
  wallet_verified boolean not null default false,
  status        text not null default 'requested'
    check (status in ('requested', 'approved', 'paid', 'rejected')),
  -- What the operator sent, so a dispute has something to point at.
  tx_reference  text not null default '',
  note          text not null default '',
  requested_at  timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references auth.users (id)
);

create index if not exists payout_requests_user on payout_requests (user_id, requested_at desc);
create index if not exists payout_requests_open on payout_requests (status, requested_at);

alter table payout_requests enable row level security;

drop policy if exists payout_read_own on payout_requests;
create policy payout_read_own on payout_requests
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- No insert, update or delete policy for anybody but an admin. With RLS on,
-- that is a refusal: a request is made through the function below, which is
-- the only thing that can move a balance.
drop policy if exists payout_admin on payout_requests;
create policy payout_admin on payout_requests
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on payout_requests from anon, authenticated;
grant select on payout_requests to authenticated;

/**
 * The smallest payout worth the fees of sending it.
 *
 * A number, in coins, rather than a setting, because it is arithmetic about
 * network fees rather than a policy an operator changes weekly. Moving it is a
 * migration, which is the right amount of friction.
 */
create or replace function public.request_payout(coins numeric)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid       uuid := auth.uid();
  cfg       coin_config%rowtype;
  balance   numeric(20, 4);
  p         profiles%rowtype;
  minimum   constant numeric := 1000;
  new_id    uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into cfg from coin_config where id;
  select * into p from profiles where id = uid;

  if p is null or not public.coin_profile_complete(uid) then
    raise exception 'your details are needed before a payout can be sent' using errcode = '22023';
  end if;
  if p.suspended then
    -- Same reasoning as everywhere else: a suspended account is not told which
    -- signal gave it away.
    raise exception 'this account cannot request a payout at the moment' using errcode = '22023';
  end if;
  if coalesce(p.wallet_address, '') = '' or coalesce(p.wallet_network, '') = '' then
    raise exception 'add a payout wallet first' using errcode = '22023';
  end if;

  if exists (select 1 from payout_requests r
             where r.user_id = uid and r.status in ('requested', 'approved')) then
    raise exception 'you already have a payout waiting' using errcode = '22023';
  end if;

  if coins is null or coins <= 0 then
    raise exception 'ask for a number of coins greater than zero' using errcode = '22023';
  end if;
  if coins < minimum then
    raise exception 'the smallest payout is % coins', minimum using errcode = '22023';
  end if;

  select total into balance from coin_balances where user_id = uid;
  if coalesce(balance, 0) < coins then
    raise exception 'you have % coins, which is less than %', coalesce(balance, 0), coins
      using errcode = '22023';
  end if;

  -- Deducted here, in the same statement that records the claim. A balance
  -- that still shows coins already claimed is a balance somebody claims twice.
  update coin_balances
     set total = total - coins, updated_at = now()
   where user_id = uid;

  insert into payout_requests
    (user_id, coins, coin_to_usd, amount_usd, wallet_address, wallet_network, wallet_verified)
  values
    (uid, coins, cfg.coin_to_usd,
     case when cfg.coin_to_usd is null then null else round(coins * cfg.coin_to_usd, 2) end,
     p.wallet_address, p.wallet_network, p.wallet_verified_at is not null)
  returning id into new_id;

  return jsonb_build_object('id', new_id, 'coins', coins, 'balance', coalesce(balance, 0) - coins);
end;
$function$;

revoke all on function public.request_payout(numeric) from public, anon;
grant execute on function public.request_payout(numeric) to authenticated;

/**
 * An operator settling a request.
 *
 * Rejecting **returns the coins**, because they were taken when the request
 * was made and a refusal that keeps them is theft by bookkeeping. Paying does
 * not return them, obviously, and records what was sent.
 */
create or replace function public.settle_payout(request_id uuid, decision text, reference text, why text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r payout_requests%rowtype;
begin
  if not public.is_admin() then
    raise exception 'not an operator' using errcode = '28000';
  end if;
  if decision not in ('paid', 'rejected', 'approved') then
    raise exception 'decision must be approved, paid or rejected' using errcode = '22023';
  end if;

  select * into r from payout_requests where id = request_id for update;
  if r is null then
    raise exception 'no such payout request' using errcode = '22023';
  end if;
  if r.status in ('paid', 'rejected') then
    raise exception 'that request was already settled as %', r.status using errcode = '22023';
  end if;

  if decision = 'rejected' then
    -- The coins go back. They were taken when the request was made.
    insert into coin_balances (user_id, total, updated_at)
    values (r.user_id, r.coins, now())
    on conflict (user_id) do update
      set total = coin_balances.total + excluded.total, updated_at = now();
  end if;

  update payout_requests
     set status = decision,
         tx_reference = coalesce(nullif(trim(reference), ''), tx_reference),
         note = coalesce(nullif(trim(why), ''), note),
         decided_at = now(),
         decided_by = auth.uid()
   where id = request_id;

  return jsonb_build_object('id', request_id, 'status', decision);
end;
$function$;

revoke all on function public.settle_payout(uuid, text, text, text) from public, anon;
grant execute on function public.settle_payout(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Proving a wallet belongs to the person asking to be paid into it.
--
-- Storing an address is not proof of anything, and a payout to an address
-- nobody proved is a payout to whoever typed last. Proof means signing a
-- message with the key that owns the address.
--
-- The signature cannot be checked here: Postgres has no secp256k1 recovery,
-- and pgcrypto does not provide one. So this stores the challenge and the
-- signature, and **Slash Operations verifies it server-side** before a payout
-- is settled. That keeps the check off the client, which is the part that
-- matters — a browser that marked its own wallet verified would be proving
-- nothing at all.
-- ---------------------------------------------------------------------------

alter table profiles
  add column if not exists wallet_challenge      text not null default '',
  add column if not exists wallet_challenge_at   timestamptz,
  add column if not exists wallet_signature      text not null default '';

comment on column profiles.wallet_challenge is
  'The exact text the collector must sign with their wallet. Regenerated on request; a signature is only meaningful against the challenge that was current when it was made.';

/** Issues a fresh challenge for the caller to sign. */
create or replace function public.issue_wallet_challenge()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid  uuid := auth.uid();
  text_challenge text;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Readable on purpose: somebody is about to be asked to sign it in a wallet,
  -- and a string of hex that says nothing is how people are phished. It names
  -- what it is for, who it is for, and when it was made.
  text_challenge := format(
    'Slash Coin payout wallet verification%s%s%sAccount: %s%sIssued: %s%sNonce: %s',
    chr(10), chr(10), '', uid, chr(10),
    to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS UTC'), chr(10),
    encode(gen_random_bytes(16), 'hex')
  );

  update profiles
     set wallet_challenge = text_challenge,
         wallet_challenge_at = now(),
         wallet_signature = ''
   where id = uid;

  return jsonb_build_object('challenge', text_challenge);
end;
$function$;

revoke all on function public.issue_wallet_challenge() from public, anon;
grant execute on function public.issue_wallet_challenge() to authenticated;

/** Stores a signature for the current challenge. Verified by an operator. */
create or replace function public.submit_wallet_signature(signature text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  p   profiles%rowtype;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into p from profiles where id = uid;
  if p.wallet_challenge = '' then
    raise exception 'ask for a challenge first' using errcode = '22023';
  end if;
  if length(coalesce(signature, '')) not between 16 and 400 then
    raise exception 'that does not look like a signature' using errcode = '22023';
  end if;

  update profiles set wallet_signature = trim(signature) where id = uid;

  -- Deliberately does **not** set wallet_verified_at. Nothing here has checked
  -- anything; the operator application recovers the signing address and
  -- compares it, and only then is the wallet verified.
  return jsonb_build_object('stored', true);
end;
$function$;

revoke all on function public.submit_wallet_signature(text) from public, anon;
grant execute on function public.submit_wallet_signature(text) to authenticated;

-- ---------------------------------------------------------------------------
-- The profile the browser reads, now carrying the payout state.
-- ---------------------------------------------------------------------------
create or replace function public.coin_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  p   profiles%rowtype;
  pending payout_requests%rowtype;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into p from profiles where id = uid;
  if not found then
    return jsonb_build_object(
      'email', coalesce((select u.email from auth.users u where u.id = uid), ''),
      'complete', false
    );
  end if;

  select * into pending from payout_requests
   where user_id = uid order by requested_at desc limit 1;

  return jsonb_build_object(
    'email',            p.email,
    'fullName',         p.full_name,
    'dateOfBirth',      p.date_of_birth,
    'addressLine1',     p.address_line1,
    'addressLine2',     p.address_line2,
    'city',             p.city,
    'region',           p.region,
    'postcode',         p.postcode,
    'country',          p.country,
    'phone',            p.phone,
    'walletAddress',    p.wallet_address,
    'walletNetwork',    p.wallet_network,
    'walletVerified',   p.wallet_verified_at is not null,
    'walletChallenge',  p.wallet_challenge,
    'walletSigned',     p.wallet_signature <> '',
    'emailOptOut',      p.email_opt_out,
    'updatedAt',        case when p.profile_updated_at is null then null
                        else extract(epoch from p.profile_updated_at) * 1000 end,
    'complete',         p.profile_updated_at is not null,
    'payout',           case when pending.id is null then null else jsonb_build_object(
                          'id', pending.id,
                          'coins', pending.coins,
                          'status', pending.status,
                          'amountUsd', pending.amount_usd,
                          'requestedAt', extract(epoch from pending.requested_at) * 1000,
                          'reference', pending.tx_reference,
                          'note', pending.note
                        ) end
  );
end;
$function$;

revoke all on function public.coin_profile() from public, anon;
grant execute on function public.coin_profile() to authenticated;
