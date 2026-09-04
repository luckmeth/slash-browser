-- Slash Coin: the pre-launch rewards ledger.
--
-- The rule this whole file exists to enforce: **the server is the authority on
-- balances; the client only ever reports intervals.** Coins are intended to
-- become tradeable, so a balance the client owns is a balance the client can
-- forge. Nothing here accepts a total from a browser.
--
-- The client is assumed hostile. It is a desktop application on a machine its
-- owner controls, so its clock, its device id and its request volume are all
-- attacker-chosen. Every rule below is written against that assumption.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Config: one row, read by everybody, written by admins.
-- ---------------------------------------------------------------------------
create table if not exists coin_config (
  id                boolean primary key default true check (id),
  coins_per_hour    numeric(12, 4) not null default 10 check (coins_per_hour >= 0),
  daily_cap_seconds integer        not null default 21600 check (daily_cap_seconds between 0 and 86400),
  -- How far back a browser may report. An interval older than this is refused
  -- outright: it is either a client that has been offline for a fortnight or a
  -- replay of a captured batch, and the second is worth more than the first.
  max_age_days      integer        not null default 7 check (max_age_days between 1 and 90),
  -- Tolerance for an honest clock being slightly ahead. Anything beyond it is
  -- a client claiming time that has not happened yet.
  clock_skew_seconds integer       not null default 120 check (clock_skew_seconds between 0 and 3600),
  campaign_ends_at  timestamptz    not null default (now() + interval '90 days'),
  updated_by        uuid references auth.users (id) on delete set null,
  updated_at        timestamptz    not null default now()
);

insert into coin_config (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Profiles: a rewards account. Distinct from `advertisers`, which is the other
-- kind of person who signs in to this project.
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text not null default '',
  display_name text not null default '',
  -- Set by an admin when a ledger looks fabricated. Suspended accounts keep
  -- their history — deleting the evidence of fraud along with the fraud makes
  -- an appeal impossible to judge.
  suspended    boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Devices. The id is client-generated and therefore meaningless as identity —
-- it exists so a ledger can be *read* per machine, and so one account farming
-- across twenty fake device ids is visible rather than invisible.
-- ---------------------------------------------------------------------------
create table if not exists devices (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  device_id  text not null check (length(device_id) between 8 and 128),
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  unique (user_id, device_id)
);

-- ---------------------------------------------------------------------------
-- The ledger. Append-only: no update policy, no delete policy, no client write
-- path of any kind. Every row is one closed interval of qualifying time.
-- ---------------------------------------------------------------------------
create table if not exists coin_intervals (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users (id) on delete cascade,
  device_id         text not null,
  started_at        timestamptz not null,
  ended_at          timestamptz not null,
  -- Seconds actually credited, after the daily cap was applied. This is not
  -- necessarily the span: a batch that crosses the cap is credited in part,
  -- and the row records what was paid rather than what was asked for.
  qualifying_seconds integer not null check (qualifying_seconds >= 0),
  claimed_seconds    integer not null check (claimed_seconds >= 0),
  coins              numeric(20, 4) not null check (coins >= 0),
  day                date not null,
  created_at         timestamptz not null default now(),

  constraint coin_intervals_ordered check (ended_at > started_at),
  -- Cannot claim more time than the interval physically contains.
  constraint coin_intervals_within_span
    check (claimed_seconds <= ceil(extract(epoch from (ended_at - started_at)))::integer + 1),

  -- The fraud boundary, expressed as a constraint rather than as code. One
  -- account cannot hold two overlapping intervals however many devices it
  -- reports from, and this holds even if the crediting function below is
  -- wrong. Twenty machines signed into one account earn the time of one.
  constraint coin_intervals_no_overlap
    exclude using gist (
      user_id with =,
      tstzrange(started_at, ended_at, '[)') with &&
    )
);

create index if not exists coin_intervals_user_day on coin_intervals (user_id, day);
create index if not exists coin_intervals_created on coin_intervals (created_at desc);

-- ---------------------------------------------------------------------------
-- Balances. Derived, maintained only by the crediting function.
-- ---------------------------------------------------------------------------
create table if not exists coin_balances (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  total      numeric(20, 4) not null default 0 check (total >= 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- The crediting function: the one write path into the ledger.
--
-- Returns a summary rather than raising on a bad entry, because a batch is a
-- fortnight of a real person's browsing and one malformed row in it should not
-- discard the rest. Each entry is validated in its own block: a rejection is
-- counted and skipped, never fatal.
-- ---------------------------------------------------------------------------
create or replace function public.record_coin_intervals(entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid       uuid := auth.uid();
  cfg       coin_config%rowtype;
  e         jsonb;
  v_device  text;
  v_start   timestamptz;
  v_end     timestamptz;
  v_claimed integer;
  v_span    integer;
  v_day     date;
  v_used    integer;
  v_allow   integer;
  v_credit  integer;
  v_coins   numeric(20, 4);
  accepted  integer := 0;
  rejected  integer := 0;
  credited  numeric(20, 4) := 0;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if jsonb_typeof(entries) <> 'array' then
    raise exception 'entries must be an array' using errcode = '22023';
  end if;

  -- A bounded batch. Without this an unauthenticated-looking client can hand
  -- the database a hundred megabytes of JSON and make this everybody's problem.
  if jsonb_array_length(entries) > 500 then
    raise exception 'batch too large' using errcode = '22023';
  end if;

  select * into cfg from coin_config where id;

  insert into profiles (id, email)
  select uid, coalesce((select u.email from auth.users u where u.id = uid), '')
  on conflict (id) do nothing;

  -- A suspended account reports normally and earns nothing. It is deliberately
  -- not an error: telling somebody the exact moment they were caught only
  -- teaches them which signal to change.
  if exists (select 1 from profiles p where p.id = uid and p.suspended) then
    return jsonb_build_object(
      'accepted', 0,
      'rejected', jsonb_array_length(entries),
      'credited', 0,
      'balance',  coalesce((select total from coin_balances where user_id = uid), 0)
    );
  end if;

  for e in select value from jsonb_array_elements(entries)
  loop
    begin
      v_device  := coalesce(e ->> 'deviceId', '');
      v_start   := (e ->> 'startedAt')::timestamptz;
      v_end     := (e ->> 'endedAt')::timestamptz;
      v_claimed := coalesce((e ->> 'seconds')::integer, 0);

      -- Every one of these is a fraud control, not a validation nicety.
      if length(v_device) not between 8 and 128     -- a real device id
         or v_end <= v_start                        -- ordered
         or v_claimed <= 0                          -- claims something
         or v_end > now() + make_interval(secs => cfg.clock_skew_seconds)  -- not the future
         or v_start < now() - make_interval(days => cfg.max_age_days)      -- not a replay
      then
        rejected := rejected + 1;
        continue;
      end if;

      -- Cannot claim more seconds than the interval physically contains. This
      -- is the check that stops "I browsed for four seconds and earned a day".
      v_span := ceil(extract(epoch from (v_end - v_start)))::integer;
      if v_claimed > v_span then
        rejected := rejected + 1;
        continue;
      end if;

      -- The daily cap, applied against what this account has already been paid
      -- for that day across every device.
      v_day := (v_start at time zone 'utc')::date;
      select coalesce(sum(ci.qualifying_seconds), 0) into v_used
      from coin_intervals ci
      where ci.user_id = uid and ci.day = v_day;

      v_allow  := greatest(cfg.daily_cap_seconds - v_used, 0);
      v_credit := least(v_claimed, v_allow);
      v_coins  := round((v_credit::numeric / 3600) * cfg.coins_per_hour, 4);

      -- Inserted even when the cap credited nothing, because the row is what
      -- reserves the time range. Dropping it would leave those seconds free to
      -- be claimed again tomorrow against a fresh cap.
      insert into coin_intervals
        (user_id, device_id, started_at, ended_at, qualifying_seconds, claimed_seconds, coins, day)
      values
        (uid, v_device, v_start, v_end, v_credit, v_claimed, v_coins, v_day);

      insert into devices (user_id, device_id, last_seen)
      values (uid, v_device, now())
      on conflict (user_id, device_id) do update set last_seen = now();

      accepted := accepted + 1;
      credited := credited + v_coins;

    exception
      -- An interval overlapping one already banked. This is the normal shape of
      -- both a retry of a batch that did land and a second machine replaying
      -- the same hours, and neither is worth an error.
      when exclusion_violation or unique_violation then
        rejected := rejected + 1;
      -- A malformed timestamp or a non-numeric second count. Caught by
      -- *category* (22xxx) rather than by naming individual codes: the first
      -- version listed `invalid_text_representation` and missed
      -- `invalid_datetime_format`, so a single entry reading "not-a-date"
      -- aborted the whole batch instead of being skipped — which a hostile
      -- client could have used to throw away an honest user's fortnight.
      when data_exception then
        rejected := rejected + 1;
    end;
  end loop;

  if credited > 0 then
    insert into coin_balances (user_id, total, updated_at)
    values (uid, credited, now())
    on conflict (user_id) do update
      set total = coin_balances.total + excluded.total,
          updated_at = now();
  end if;

  return jsonb_build_object(
    'accepted', accepted,
    'rejected', rejected,
    'credited', credited,
    'balance',  coalesce((select total from coin_balances where user_id = uid), 0)
  );
end;
$function$;

revoke all on function public.record_coin_intervals(jsonb) from public, anon;
grant execute on function public.record_coin_intervals(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security.
--
-- Note what has no policy at all: there is no insert, update or delete policy
-- on `coin_intervals` or `coin_balances` for anyone. With RLS on, that is a
-- refusal — the ledger is reachable only through the definer function above.
-- ---------------------------------------------------------------------------
alter table coin_config    enable row level security;
alter table profiles       enable row level security;
alter table devices        enable row level security;
alter table coin_intervals enable row level security;
alter table coin_balances  enable row level security;

drop policy if exists coin_config_read on coin_config;
create policy coin_config_read on coin_config
  for select using (true);

drop policy if exists coin_config_admin on coin_config;
create policy coin_config_admin on coin_config
  for update using (is_admin()) with check (is_admin());

drop policy if exists profiles_own on profiles;
create policy profiles_own on profiles
  for select using (id = auth.uid() or is_admin());

drop policy if exists profiles_own_update on profiles;
create policy profiles_own_update on profiles
  for update using (id = auth.uid())
  -- A user may rename themselves. They may not un-suspend themselves.
  with check (id = auth.uid() and suspended = (select p.suspended from profiles p where p.id = auth.uid()));

drop policy if exists profiles_admin_update on profiles;
create policy profiles_admin_update on profiles
  for update using (is_admin()) with check (is_admin());

drop policy if exists devices_own on devices;
create policy devices_own on devices
  for select using (user_id = auth.uid() or is_admin());

drop policy if exists coin_intervals_own on coin_intervals;
create policy coin_intervals_own on coin_intervals
  for select using (user_id = auth.uid() or is_admin());

drop policy if exists coin_balances_own on coin_balances;
create policy coin_balances_own on coin_balances
  for select using (user_id = auth.uid() or is_admin());

-- ---------------------------------------------------------------------------
-- Signup routing.
--
-- `handle_new_user` made every new account an advertiser, which was right when
-- advertisers were the only people who signed in. A browser user signing in to
-- collect coins would have appeared in the advertiser list — and, worse, in
-- whatever the admin application counts as demand.
--
-- The browser's OAuth sends `slash_client: 'browser'` in its signup metadata.
-- Anything without that flag keeps the previous behaviour exactly, so no
-- existing portal signup changes.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Everyone who signs in gets a rewards profile; it is the account row, and
  -- an advertiser earning coins while their campaign runs is harmless.
  insert into profiles (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), '')
  )
  on conflict (id) do nothing;

  if coalesce(new.raw_user_meta_data ->> 'slash_client', '') = 'browser' then
    return new;
  end if;

  insert into advertisers (auth_user_id, company_name, contact_email)
  values (
    new.id,
    -- Company name comes from signup metadata. Google sign-in carries no such
    -- field, so it falls back to the email domain — a sensible placeholder the
    -- advertiser can correct, rather than an empty row that fails its own check
    -- constraint and takes the whole signup down with it.
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'company_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 2), ''),
      'New advertiser'
    ),
    coalesce(new.email, '')
  )
  on conflict (auth_user_id) do nothing;
  return new;
end;
$function$;

-- Backfill a profile for anyone who signed up before this migration.
insert into profiles (id, email)
select u.id, coalesce(u.email, '') from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Telling a browser user apart from an advertiser.
--
-- The signup trigger cannot do it alone: Supabase's OAuth `/authorize` endpoint
-- takes no custom signup metadata, so a Google sign-in from the browser arrives
-- looking exactly like a Google sign-in from the advertiser portal, and the
-- `slash_client` gate above only catches the password/admin-created case. Left
-- there, every browser user collecting coins would appear in the advertiser
-- list — and in whatever the admin application counts as demand.
--
-- So the browser says so itself, immediately after signing in.
-- ---------------------------------------------------------------------------
alter table profiles add column if not exists client text not null default '';

create or replace function public.mark_browser_account()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  insert into profiles (id, email)
  select uid, coalesce((select u.email from auth.users u where u.id = uid), '')
  on conflict (id) do nothing;

  update profiles set client = 'browser' where id = uid;

  -- Remove the advertiser row the signup trigger created, but only while it is
  -- genuinely untouched. Somebody who advertises *and* uses the browser keeps
  -- both: the moment a campaign or a payment exists, this deletes nothing.
  delete from advertisers a
  where a.auth_user_id = uid
    and not exists (select 1 from campaigns c where c.advertiser_id = a.id)
    and not exists (select 1 from payments p where p.advertiser_id = a.id);
end;
$function$;

revoke all on function public.mark_browser_account() from public, anon;
grant execute on function public.mark_browser_account() to authenticated;

-- ---------------------------------------------------------------------------
-- What the browser reads on the rewards screen. One round trip rather than
-- three, and it is the only place the daily total is computed.
-- ---------------------------------------------------------------------------
create or replace function public.coin_state()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  cfg coin_config%rowtype;
begin
  select * into cfg from coin_config where id;

  if uid is null then
    return jsonb_build_object(
      'signedIn', false, 'balance', 0, 'secondsToday', 0,
      'coinsPerHour', cfg.coins_per_hour,
      'dailyCapSeconds', cfg.daily_cap_seconds,
      'campaignEndsAt', extract(epoch from cfg.campaign_ends_at) * 1000
    );
  end if;

  return jsonb_build_object(
    'signedIn', true,
    'balance', coalesce((select total from coin_balances where user_id = uid), 0),
    'secondsToday', coalesce((
      select sum(qualifying_seconds) from coin_intervals
      where user_id = uid and day = (now() at time zone 'utc')::date
    ), 0),
    'suspended', coalesce((select suspended from profiles where id = uid), false),
    'coinsPerHour', cfg.coins_per_hour,
    'dailyCapSeconds', cfg.daily_cap_seconds,
    'campaignEndsAt', extract(epoch from cfg.campaign_ends_at) * 1000
  );
end;
$function$;

revoke all on function public.coin_state() from public;
grant execute on function public.coin_state() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The published rates.
--
-- Both are **nullable on purpose**. A rate nobody has set yet is not "zero" —
-- zero is a rate, and showing it would tell somebody their coins are worth
-- nothing rather than that the figure has not been decided. Null renders as
-- "Pending" in the browser, which is the truth until an operator sets it.
-- ---------------------------------------------------------------------------
alter table coin_config
  add column if not exists coin_to_usd numeric(20, 8),
  add column if not exists launch_at timestamptz;

comment on column coin_config.coin_to_usd is
  'Indicative USD value of one Slash Coin. NULL means not yet published, which the browser shows as Pending. Setting this is a claim about money - see docs/SLASH-COIN.md.';
comment on column coin_config.launch_at is
  'When the pre-launch period ends. NULL falls back to campaign_ends_at.';
create or replace function public.coin_state()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  cfg coin_config%rowtype;
  base jsonb;
begin
  select * into cfg from coin_config where id;

  -- The published figures, shared by signed-in and anonymous callers alike:
  -- somebody deciding whether to opt in should see the rate before they do.
  -- `coinToUsd` and `launchAt` stay null when unset so the browser can say
  -- "Pending" rather than invent a zero.
  base := jsonb_build_object(
    'coinsPerHour',    cfg.coins_per_hour,
    'dailyCapSeconds', cfg.daily_cap_seconds,
    'coinToUsd',       cfg.coin_to_usd,
    'launchAt',        case when cfg.launch_at is null then null
                       else extract(epoch from cfg.launch_at) * 1000 end,
    'campaignEndsAt',  extract(epoch from cfg.campaign_ends_at) * 1000
  );

  if uid is null then
    return base || jsonb_build_object('signedIn', false, 'balance', 0, 'secondsToday', 0);
  end if;

  return base || jsonb_build_object(
    'signedIn', true,
    'balance', coalesce((select total from coin_balances where user_id = uid), 0),
    'secondsToday', coalesce((
      select sum(qualifying_seconds) from coin_intervals
      where user_id = uid and day = (now() at time zone 'utc')::date
    ), 0),
    'suspended', coalesce((select suspended from profiles where id = uid), false)
  );
end;
$function$;

revoke all on function public.coin_state() from public;
grant execute on function public.coin_state() to anon, authenticated;
