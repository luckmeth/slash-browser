-- Creative storage, and the rows the apps expect to find on first run.

-- ---------------------------------------------------------------------------
-- campaign-assets bucket
-- ---------------------------------------------------------------------------

-- Private. Creatives are served to browsers by being inlined into the batch as
-- data URLs, never linked — so nothing here needs to be publicly readable, and
-- a public bucket would let anyone enumerate every advertiser's artwork.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'campaign-assets',
  'campaign-assets',
  false,
  524288,  -- 512 KB. The batch carries every live image inline; see README.
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

-- Uploads land in a folder named for the uploader's auth id, and that is the
-- only folder they may write to. Without the prefix check, any signed-in
-- advertiser could overwrite another's creative — including one already
-- approved, which is how an approved advert quietly becomes a different advert.
create policy campaign_assets_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'campaign-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy campaign_assets_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'campaign-assets'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

create policy campaign_assets_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'campaign-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy campaign_assets_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'campaign-assets'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- ---------------------------------------------------------------------------
-- Placements on sale
-- ---------------------------------------------------------------------------

-- Starting rates, not researched ones. Set them from the admin app once there
-- is an audience to price against; the landing page reads whatever is here, so
-- changing a number is a change everyone sees immediately.
insert into pricing_config
  (placement_tier, display_name, description, hourly_rate, min_hours, max_concurrent)
values
  ('home_banner', 'Start page tile',
   'One clearly-labelled tile on the start page, shown when a reader opens a new tab.',
   2.50, 24, 6),
  ('newtab_feature', 'Featured placement',
   'The first tile position, shown ahead of the rotation.',
   4.00, 24, 2)
on conflict (placement_tier) do nothing;

-- ---------------------------------------------------------------------------
-- Remote config the browser reads
-- ---------------------------------------------------------------------------

insert into browser_settings (key, value) values
  -- Whether the browser's start page offers the "advertise here" entry point.
  ('show_advertise_cta', 'true'::jsonb),
  -- Shown on the start page when set; cleared by setting message to "".
  ('notice', '{"message": "", "level": "info", "url": ""}'::jsonb),
  -- Rollout flags. The browser treats an unknown key as off.
  ('feature_flags', '{}'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Operator settings
-- ---------------------------------------------------------------------------

-- Non-secret only. The Stripe secret key and webhook signing secret live in the
-- host's encrypted environment — see platform/README.md for why this table is
-- not the place for them.
insert into platform_settings (key, value) values
  ('stripe_mode', '"test"'::jsonb),
  ('stripe_publishable_key', '""'::jsonb),
  ('currency', '"usd"'::jsonb),
  ('support_email', '""'::jsonb),
  -- How far ahead a campaign must start. A batch is fetched every six hours, so
  -- anything sooner may simply not reach the readers it was sold to.
  ('min_lead_time_hours', '12'::jsonb)
on conflict (key) do nothing;
