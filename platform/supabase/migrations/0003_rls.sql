-- Row-level security.
--
-- Two mechanisms are used together, because they answer different questions:
--
--   RLS policies decide WHICH ROWS an account may touch.
--   Column grants decide WHICH COLUMNS it may write.
--
-- Only the second can stop an advertiser setting their own campaign's status to
-- 'active' or its total_cost to zero on a row they legitimately own. A policy
-- alone would let that through, because the row is genuinely theirs.

alter table advertisers      enable row level security;
alter table admin_users      enable row level security;
alter table campaigns        enable row level security;
alter table payments         enable row level security;
alter table pricing_config   enable row level security;
alter table price_history    enable row level security;
alter table platform_settings enable row level security;
alter table browser_settings enable row level security;
alter table delivery_counts  enable row level security;
alter table email_log        enable row level security;

-- ---------------------------------------------------------------------------
-- advertisers
-- ---------------------------------------------------------------------------

create policy advertisers_read_own on advertisers
  for select to authenticated
  using (auth_user_id = auth.uid() or public.is_admin());

-- Signup creates its own row, and may only claim its own auth user.
create policy advertisers_create_own on advertisers
  for insert to authenticated
  with check (auth_user_id = auth.uid());

create policy advertisers_update_own on advertisers
  for update to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

revoke all on advertisers from authenticated, anon;
grant select on advertisers to authenticated;
grant insert (auth_user_id, company_name, contact_email) on advertisers to authenticated;
-- Not status: an advertiser must not be able to lift their own suspension.
grant update (company_name, contact_email) on advertisers to authenticated;

-- ---------------------------------------------------------------------------
-- admin_users — readable by admins, writable by nobody through the API
-- ---------------------------------------------------------------------------

create policy admin_users_read on admin_users
  for select to authenticated
  using (public.is_admin());

revoke all on admin_users from authenticated, anon;
grant select on admin_users to authenticated;
-- Deliberately no insert grant. Admins are added with the service role or from
-- the SQL editor. A self-serve path to becoming an admin is a self-serve path
-- to approving your own adverts.

-- ---------------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------------

create policy campaigns_read_own on campaigns
  for select to authenticated
  using (advertiser_id = public.current_advertiser_id() or public.is_admin());

create policy campaigns_create_own on campaigns
  for insert to authenticated
  with check (advertiser_id = public.current_advertiser_id());

-- Editable only while unpaid. After payment the campaign is a thing somebody
-- bought; changing its destination afterwards is how an approved advert becomes
-- a link to something else entirely.
create policy campaigns_update_unpaid on campaigns
  for update to authenticated
  using (
    advertiser_id = public.current_advertiser_id() and status = 'pending_payment'
  )
  with check (advertiser_id = public.current_advertiser_id());

create policy campaigns_delete_unpaid on campaigns
  for delete to authenticated
  using (
    advertiser_id = public.current_advertiser_id() and status = 'pending_payment'
  );

create policy campaigns_admin_all on campaigns
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on campaigns from authenticated, anon;
grant select, delete on campaigns to authenticated;
-- status, hourly_rate_snapshot, total_hours, total_cost and review_note are
-- absent on purpose. Status arrives from the payment webhook and the review
-- queue; the money columns are computed by the pricing trigger. Neither is
-- something a client may state.
grant insert (advertiser_id, title, description, destination_link, image_path,
              placement_tier, starts_at, ends_at) on campaigns to authenticated;
grant update (title, description, destination_link, image_path,
              placement_tier, starts_at, ends_at) on campaigns to authenticated;

-- ---------------------------------------------------------------------------
-- payments — readable, never writable from a browser
-- ---------------------------------------------------------------------------

create policy payments_read_own on payments
  for select to authenticated
  using (advertiser_id = public.current_advertiser_id() or public.is_admin());

revoke all on payments from authenticated, anon;
grant select on payments to authenticated;
-- No insert or update grant at any privilege below service role. Payment rows
-- are written by the Stripe webhook after verifying the signature, which is the
-- only place that knows a payment actually happened.

-- ---------------------------------------------------------------------------
-- pricing_config — public to read, admin to change
-- ---------------------------------------------------------------------------

-- The landing page shows live prices to signed-out visitors, so the price
-- quoted and the price charged cannot drift apart.
create policy pricing_public_read on pricing_config
  for select to anon, authenticated
  using (active or public.is_admin());

create policy pricing_admin_write on pricing_config
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on pricing_config from authenticated, anon;
grant select on pricing_config to anon, authenticated;
grant insert, update, delete on pricing_config to authenticated;

create policy price_history_admin on price_history
  for select to authenticated
  using (public.is_admin());

revoke all on price_history from authenticated, anon;
grant select on price_history to authenticated;

-- ---------------------------------------------------------------------------
-- platform_settings — never public
-- ---------------------------------------------------------------------------

create policy platform_settings_admin on platform_settings
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on platform_settings from authenticated, anon;
grant select, insert, update, delete on platform_settings to authenticated;

-- ---------------------------------------------------------------------------
-- browser_settings — public by design
-- ---------------------------------------------------------------------------

-- Every copy of Slash reads this unauthenticated. Nothing may be put here that
-- is not already public; it is remote config, not a config store.
create policy browser_settings_public_read on browser_settings
  for select to anon, authenticated
  using (true);

create policy browser_settings_admin_write on browser_settings
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on browser_settings from authenticated, anon;
grant select on browser_settings to anon, authenticated;
grant insert, update, delete on browser_settings to authenticated;

-- ---------------------------------------------------------------------------
-- delivery_counts — an advertiser sees their own numbers only
-- ---------------------------------------------------------------------------

create policy delivery_read_own on delivery_counts
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from campaigns c
      where c.id = delivery_counts.campaign_id
        and c.advertiser_id = public.current_advertiser_id()
    )
  );

revoke all on delivery_counts from authenticated, anon;
grant select on delivery_counts to authenticated;
-- Written only by record_delivery(), called with the service role from the
-- report endpoint. Counts that a client could write are counts a client can
-- invent.

-- ---------------------------------------------------------------------------
-- email_log — operators only
-- ---------------------------------------------------------------------------

create policy email_log_admin on email_log
  for select to authenticated
  using (public.is_admin());

revoke all on email_log from authenticated, anon;
grant select on email_log to authenticated;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

revoke all on function public.advance_campaign_states() from anon, authenticated;
revoke all on function public.record_delivery(jsonb) from anon, authenticated;
-- Both are security definer and are called with the service role only. Leaving
-- them executable by authenticated would hand any signed-in advertiser the
-- ability to write delivery figures for their own campaigns.

grant execute on function public.tier_peak_load(text, timestamptz, timestamptz, uuid)
  to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.current_advertiser_id() to authenticated;
