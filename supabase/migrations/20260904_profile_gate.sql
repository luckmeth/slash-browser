-- ---------------------------------------------------------------------------
-- EARNING NEEDS A PROFILE
--
-- Collecting is now gated on the collector having told us who they are: a
-- name, a date of birth, an address, a country and a phone number. Until then
-- nothing accrues.
--
-- **The gate is here, not in the browser.** The browser stops its own timer as
-- well, because banking hours it is about to be told to throw away is a worse
-- experience than not starting -- but that is a courtesy. This function is the
-- only write path into the ledger, and it is where "no profile, no coins" is
-- true regardless of what a client believes.
--
-- **Time before the profile is not banked and paid later.** A batch arriving
-- from an incomplete account is refused, not held. Otherwise "unlocked by
-- filling in your details" would really mean "backdated once you get round to
-- it", which is a different offer and a much more attackable one: a farm could
-- run for a fortnight and then decide whether it was worth completing a form.
--
-- What counts as complete is `profile_updated_at is not null` **and** the five
-- fields being non-empty. The browser refuses to save a partial profile, so
-- the timestamp alone would nearly always be enough; nearly is not a word this
-- function is allowed to use, since it is the thing standing between an edited
-- client and the ledger.
-- ---------------------------------------------------------------------------

create or replace function public.coin_profile_complete(uid uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    (select p.profile_updated_at is not null
        and length(trim(p.full_name)) > 1
        and p.date_of_birth is not null
        and length(trim(p.address_line1)) > 0
        and length(trim(p.city)) > 0
        and p.country <> ''
        and length(trim(p.phone)) > 0
     from profiles p where p.id = uid),
    false
  );
$function$;

revoke all on function public.coin_profile_complete(uuid) from public, anon;
grant execute on function public.coin_profile_complete(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The state the browser reads, now carrying whether earning is unlocked.
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
    return base || jsonb_build_object(
      'signedIn', false, 'balance', 0, 'secondsToday', 0, 'profileComplete', false
    );
  end if;

  return base || jsonb_build_object(
    'signedIn', true,
    'balance', coalesce((select total from coin_balances where user_id = uid), 0),
    'secondsToday', coalesce((
      select sum(qualifying_seconds) from coin_intervals
      where user_id = uid and day = (now() at time zone 'utc')::date
    ), 0),
    'suspended', coalesce((select suspended from profiles where id = uid), false),
    -- What unlocks collecting. The browser shows the form until this is true
    -- and does not start its timer.
    'profileComplete', public.coin_profile_complete(uid)
  );
end;
$function$;

revoke all on function public.coin_state() from public;
grant execute on function public.coin_state() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The ledger write path, with the gate in it.
--
-- Unchanged from 20260903 except for the profile check: the pause, the
-- suspension, every fraud control, the daily cap and the catch-by-category are
-- the same and are commented where they were.
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

  -- Earning switched off for everybody. Not an error, for the same reason a
  -- suspended account is not: an error is something a browser retries, and
  -- there is nothing here to retry.
  if not cfg.earning_active then
    return jsonb_build_object(
      'accepted', 0, 'rejected', jsonb_array_length(entries), 'credited', 0,
      'paused', true,
      'balance', coalesce((select total from coin_balances where user_id = uid), 0)
    );
  end if;

  -- No profile, no coins. Reported distinctly so the browser can say which
  -- silence this is, and refused rather than held: time before the details
  -- were given is not banked and paid out afterwards.
  if not public.coin_profile_complete(uid) then
    return jsonb_build_object(
      'accepted', 0, 'rejected', jsonb_array_length(entries), 'credited', 0,
      'profileIncomplete', true,
      'balance', coalesce((select total from coin_balances where user_id = uid), 0)
    );
  end if;

  -- A suspended account reports normally and earns nothing. It is deliberately
  -- not an error: telling somebody the exact moment they were caught only
  -- teaches them which signal to change.
  if exists (select 1 from profiles p where p.id = uid and p.suspended) then
    return jsonb_build_object(
      'accepted', 0, 'rejected', jsonb_array_length(entries), 'credited', 0,
      'balance', coalesce((select total from coin_balances where user_id = uid), 0)
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

      -- Cannot claim more seconds than the interval physically contains.
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
      -- reserves the time range.
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
      -- An interval overlapping one already banked: the normal shape of both a
      -- retry and a second machine replaying the same hours.
      when exclusion_violation or unique_violation then
        rejected := rejected + 1;
      -- Caught by category (22xxx) rather than by naming individual codes.
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
