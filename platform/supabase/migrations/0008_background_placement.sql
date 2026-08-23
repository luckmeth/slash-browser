-- The new-tab background placement, and review before payment.

-- ---------------------------------------------------------------------------
-- The premium placement
-- ---------------------------------------------------------------------------

-- Exclusive: one campaign at a time. That is what makes it worth its rate --
-- rotating it between four advertisers quarters the value to each of them and
-- quadruples the download every reader takes, since each live creative's image
-- ships inline in the batch.
insert into pricing_config
  (placement_tier, display_name, description, hourly_rate, min_hours, max_concurrent)
values
  ('newtab_background', 'Start page background',
   'Your image as the backdrop of the new-tab page, with your headline over it. One advertiser at a time.',
   12.00, 24, 1)
on conflict (placement_tier) do nothing;

-- ---------------------------------------------------------------------------
-- Review before payment
-- ---------------------------------------------------------------------------

-- The order was: pay, then a human looks at it. That means holding somebody's
-- money for something you then refuse, and needing a refund path for the
-- ordinary case rather than the exceptional one.
--
-- Approving first costs one extra email and removes the whole problem: a
-- rejected campaign was never charged, so there is nothing to give back.
alter table campaigns drop constraint if exists campaigns_status_check;

alter table campaigns add constraint campaigns_status_check check (
  status in (
    -- Submitted, waiting for an operator. Where a campaign now starts.
    'pending_review',
    -- Approved and waiting to be paid for.
    'approved_unpaid',
    -- Paid; waiting for its start time.
    'scheduled',
    'active',
    'rejected',
    'completed',
    'cancelled',
    -- Kept only so rows written before this migration remain valid. Nothing
    -- creates one any more.
    'pending_payment'
  )
);

alter table campaigns alter column status set default 'pending_review';

-- Anything already sitting unpaid becomes a review item, which is where it
-- would have started under the new order.
update campaigns set status = 'pending_review' where status = 'pending_payment';

-- ---------------------------------------------------------------------------
-- What an advertiser may still edit
-- ---------------------------------------------------------------------------

-- Editable while it is theirs to change: before an operator has looked at it.
-- Once approved, the thing that was approved must be the thing that runs --
-- otherwise "approved" means nothing and a reviewed advert can become a link
-- to anywhere.
drop policy if exists campaigns_update_unpaid on campaigns;
create policy campaigns_update_before_review on campaigns
  for update to authenticated
  using (
    advertiser_id = public.current_advertiser_id()
    and status in ('pending_review', 'pending_payment')
  )
  with check (advertiser_id = public.current_advertiser_id());

drop policy if exists campaigns_delete_unpaid on campaigns;
create policy campaigns_delete_before_review on campaigns
  for delete to authenticated
  using (
    advertiser_id = public.current_advertiser_id()
    and status in ('pending_review', 'pending_payment')
  );

-- The pricing trigger recomputed only while 'pending_payment'. It has to cover
-- the new starting state too, or a campaign submitted for review is priced at
-- zero and stays there.
create or replace function public.campaigns_apply_pricing()
returns trigger
language plpgsql
as $$
declare
  tier pricing_config%rowtype;
  hours numeric;
begin
  -- Frozen once approved: the rate an advertiser was quoted and approved at is
  -- what they pay, whatever the operator changes afterwards.
  if tg_op = 'UPDATE' and old.status not in ('pending_review', 'pending_payment') then
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

  if hours <> trunc(hours) then
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

-- Inventory counts anything that holds a slot: awaiting review, approved but
-- unpaid, scheduled, or running. An approved-unpaid campaign has been promised
-- those hours, and selling them twice is how one advertiser silently loses the
-- placement they were told they had.
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
      and probe.status in ('pending_review', 'approved_unpaid', 'scheduled', 'active')
      and other.status in ('pending_review', 'approved_unpaid', 'scheduled', 'active')
      and (ignore_campaign is null or probe.id <> ignore_campaign)
      and (ignore_campaign is null or other.id <> ignore_campaign)
    group by probe.id
  ) peaks;
$$;
