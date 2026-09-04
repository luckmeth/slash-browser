-- ---------------------------------------------------------------------------
-- SLASH COIN: the operator controls
--
-- Everything an operator has to be able to change without a deploy —
-- the earning rate, the daily maximum, the published value of a coin, the
-- launch date — already lived in `coin_config`, with one thing missing: a way
-- to say "earning is off for everybody, from now".
--
-- `profiles.suspended` is per-account and is an anti-abuse control. This is
-- different: it is the scheme itself being paused, and the browser has to be
-- able to say so on the rewards page rather than showing a balance that
-- silently stops moving. That is the least answerable complaint a scheme like
-- this can generate.
--
-- **Paused has to be real.** A flag the browser reads and the crediting
-- function ignores is a switch that changes a label and nothing else, which is
-- worse than no switch: an operator would believe earning had stopped while
-- the ledger carried on. So `record_coin_intervals` is re-declared here with
-- the check in it, and this file is now the current definition of both
-- functions.
-- ---------------------------------------------------------------------------

alter table coin_config
  add column if not exists earning_active boolean not null default true;

comment on column coin_config.earning_active is
  'Whether Slash Coin is accruing at all. false credits nothing for anybody and the browser says "paused"; it is the scheme being switched off, not an account being suspended (see profiles.suspended).';

-- ---------------------------------------------------------------------------
-- The state the browser reads.
--
-- `coinToUsd` and `launchAt` stay nullable: a rate nobody has set is not
-- "zero" — zero is a rate, and showing it would tell somebody their coins are
-- worth nothing rather than that the figure has not been decided. Null renders
-- as "Pending".
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
  base jsonb;
begin
  select * into cfg from coin_config where id;

  -- The published figures, shared by signed-in and anonymous callers alike:
  -- somebody deciding whether to opt in should see the rate before they do.
  base := jsonb_build_object(
    'coinsPerHour',    cfg.coins_per_hour,
    'dailyCapSeconds', cfg.daily_cap_seconds,
    'coinToUsd',       cfg.coin_to_usd,
    'launchAt',        case when cfg.launch_at is null then null
                       else extract(epoch from cfg.launch_at) * 1000 end,
    'campaignEndsAt',  extract(epoch from cfg.campaign_ends_at) * 1000,
    'earningActive',   cfg.earning_active
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

-- ---------------------------------------------------------------------------
-- The only write path into the ledger, with the pause in it.
--
-- Unchanged from 20260830 except for the `earning_active` guard: every fraud
-- control, the daily cap, the exclusion-violation handling and the
-- catch-by-category are the same, and are commented where they were.
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

  -- Earning switched off for everybody.
  --
  -- Not an error, for the same reason a suspended account is not: an error is
  -- something a browser retries, and there is nothing here to retry. It
  -- reports `paused` so the client can say which of the two silences this is,
  -- and credits nothing — time spent during a pause is not banked and paid out
  -- when the pause lifts, because that would make "paused" mean "delayed".
  if not cfg.earning_active then
    return jsonb_build_object(
      'accepted', 0,
      'rejected', jsonb_array_length(entries),
      'credited', 0,
      'paused',   true,
      'balance',  coalesce((select total from coin_balances where user_id = uid), 0)
    );
  end if;

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
