-- Server-side rules. Everything here exists because the client cannot be
-- trusted with it — a price, a status or a schedule that arrives from a browser
-- is a value somebody can edit before it arrives.

-- ---------------------------------------------------------------------------
-- Who is asking
-- ---------------------------------------------------------------------------

-- security definer, so an RLS policy on admin_users cannot recurse into itself
-- while answering "is this person an admin?".
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from admin_users where auth_user_id = auth.uid());
$$;

create or replace function public.current_advertiser_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from advertisers where auth_user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Pricing is computed here, never accepted
-- ---------------------------------------------------------------------------

-- Recomputes hours, rate and cost from the campaign window and the current
-- tier rate, discarding whatever the client sent.
--
-- Only while the campaign is unpaid. Once money has changed hands the snapshot
-- is history: an operator raising the rate next week must not retroactively
-- change what somebody already paid, and must not be able to by accident.
create or replace function public.campaigns_apply_pricing()
returns trigger
language plpgsql
as $$
declare
  tier pricing_config%rowtype;
  hours numeric;
begin
  if tg_op = 'UPDATE' and old.status <> 'pending_payment' then
    new.hourly_rate_snapshot := old.hourly_rate_snapshot;
    new.total_hours          := old.total_hours;
    new.total_cost           := old.total_cost;
    return new;
  end if;

  select * into tier from pricing_config where placement_tier = new.placement_tier;
  if not found then
    raise exception 'unknown placement tier %', new.placement_tier;
  end if;
  if not tier.active then
    raise exception 'placement % is not on sale', new.placement_tier;
  end if;

  hours := extract(epoch from (new.ends_at - new.starts_at)) / 3600.0;

  -- Whole hours only. A part-hour window would make the cost a rounded product
  -- of rounded numbers, and the client quoting the price rounds at a different
  -- moment than this does -- so the figure shown at checkout and the figure
  -- charged could differ by a cent on some windows and not others. Requiring
  -- whole hours makes them identical by construction. Mirrored in
  -- shared/src/pricing.ts.
  if hours <> trunc(hours) then
    -- Six decimal places, not two. A window that is 24 hours minus three
    -- milliseconds rounds to '24.00', and an error saying a 24.00-hour booking
    -- is not a whole number of hours costs somebody an afternoon before they
    -- think to look at the sub-second component.
    raise exception 'campaigns run for a whole number of hours (this one is %)',
      round(hours, 6);
  end if;

  if hours < tier.min_hours then
    raise exception '% is sold in blocks of at least % hours (asked for %)',
      new.placement_tier, tier.min_hours, round(hours, 2);
  end if;

  new.hourly_rate_snapshot := tier.hourly_rate;
  new.total_hours          := hours;
  new.total_cost           := hours * tier.hourly_rate;
  new.updated_at           := now();
  return new;
end;
$$;

create trigger campaigns_pricing
  before insert or update on campaigns
  for each row execute function public.campaigns_apply_pricing();

-- ---------------------------------------------------------------------------
-- Rate changes are logged, always
-- ---------------------------------------------------------------------------

create or replace function public.pricing_config_log()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' or new.hourly_rate is distinct from old.hourly_rate then
    insert into price_history (placement_tier, hourly_rate, changed_by)
    values (new.placement_tier, new.hourly_rate, auth.uid());
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger pricing_config_history
  before insert or update on pricing_config
  for each row execute function public.pricing_config_log();

-- ---------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------

-- How many campaigns are already sold against a tier at the busiest moment of a
-- proposed window.
--
-- Needed because every live creative's image ships inline in the batch that
-- every reader downloads. Overselling a tier does not degrade gracefully — it
-- makes the batch bigger for everyone, including people whose adverts are not
-- in it. Checked before a checkout session is created, so nobody pays for a
-- slot that does not exist.
create or replace function public.tier_peak_load(
  tier text,
  window_start timestamptz,
  window_end timestamptz,
  ignore_campaign uuid default null
)
returns integer
language sql
stable
as $$
  -- Every campaign overlapping the window contributes 1 across its own span.
  -- The peak is the largest number overlapping at any single campaign's start,
  -- which is where a step function of this kind can only ever peak.
  select coalesce(max(concurrent), 0)::integer
  from (
    select count(*) as concurrent
    from campaigns probe
    join campaigns other
      on other.placement_tier = probe.placement_tier
     and other.starts_at <= probe.starts_at
     and other.ends_at   >  probe.starts_at
    where probe.placement_tier = tier_peak_load.tier
      and probe.starts_at < window_end
      and probe.ends_at   > window_start
      and probe.status in ('pending_review', 'scheduled', 'active')
      and other.status in ('pending_review', 'scheduled', 'active')
      and (ignore_campaign is null or probe.id <> ignore_campaign)
      and (ignore_campaign is null or other.id <> ignore_campaign)
    group by probe.id
  ) peaks;
$$;

-- ---------------------------------------------------------------------------
-- Go-live and completion
-- ---------------------------------------------------------------------------

-- Moves campaigns across their own start and end lines. Called on a schedule
-- (see platform/README.md); nothing else flips these, so without the cron a
-- campaign would stay 'scheduled' forever and never be delivered.
--
-- Returns the ids that went live, so the caller can send the "your ad is live"
-- email for exactly those and no others — running it twice must not email
-- anyone twice.
create or replace function public.advance_campaign_states()
returns table (id uuid, new_status text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with started as (
    update campaigns set status = 'active', updated_at = now()
    where status = 'scheduled' and starts_at <= now() and ends_at > now()
    returning campaigns.id, 'active'::text as new_status
  ),
  finished as (
    update campaigns set status = 'completed', updated_at = now()
    where status in ('scheduled', 'active') and ends_at <= now()
    returning campaigns.id, 'completed'::text as new_status
  )
  select * from started
  union all
  select * from finished;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reported counts
-- ---------------------------------------------------------------------------

-- Adds a batch of aggregate counts. Called by the report endpoint with the
-- service role; ids that name no campaign are skipped rather than inserted,
-- because they would be delivery figures for something nobody served.
create or replace function public.record_delivery(entries jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  applied integer := 0;
begin
  insert into delivery_counts (campaign_id, day, impressions, clicks)
  select (e ->> 'campaignId')::uuid,
         (e ->> 'day')::date,
         greatest((e ->> 'impressions')::bigint, 0),
         greatest((e ->> 'clicks')::bigint, 0)
  from jsonb_array_elements(entries) e
  where exists (select 1 from campaigns c where c.id = (e ->> 'campaignId')::uuid)
  on conflict (campaign_id, day) do update
    set impressions = delivery_counts.impressions + excluded.impressions,
        clicks      = delivery_counts.clicks + excluded.clicks;

  get diagnostics applied = row_count;
  return applied;
end;
$$;
