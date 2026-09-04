-- ---------------------------------------------------------------------------
-- ADVERTISING FROM THE BROWSER: a write path, and a row that survives
--
-- Saving a company profile from the browser failed with
-- `400 UPDATE requires a WHERE clause`, and would have saved nothing even if
-- it had not. Two separate faults, both of them mine:
--
-- **PostgREST refuses an unfiltered UPDATE.** Supabase runs the `safeupdate`
-- extension, so `PATCH /advertisers` with no filter is rejected outright. The
-- request had no filter on purpose -- row-level security already scopes the
-- statement to the caller, and a filter would have been a second, weaker copy
-- of that rule -- but the database will not take the request at all.
--
-- **There was no row to update.** `mark_browser_account()` deletes the
-- advertiser row the signup trigger creates, whenever it is untouched, so that
-- somebody collecting Slash Coin does not appear in the advertiser list. Every
-- browser user therefore has no `advertisers` row, and an UPDATE was never
-- going to be the right verb.
--
-- One function fixes both: it upserts, keyed to `auth.uid()`, and touches only
-- the columns an advertiser owns. `status` is not among them, so a suspended
-- advertiser cannot lift their own suspension, and `auth_user_id` is taken
-- from the session rather than the request, so a row cannot be claimed for
-- somebody else.
-- ---------------------------------------------------------------------------

create or replace function public.save_advertiser_profile(details jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid  uuid := auth.uid();
  mail text;
  row_id uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if jsonb_typeof(details) <> 'object' then
    raise exception 'details must be an object' using errcode = '22023';
  end if;

  mail := coalesce((select u.email from auth.users u where u.id = uid), '');

  -- The company name is what readers see beside an advert, so it is the one
  -- field with no sensible empty value.
  if length(trim(coalesce(details ->> 'companyName', ''))) = 0 then
    raise exception 'a company name is needed' using errcode = '22023';
  end if;

  insert into advertisers (auth_user_id, company_name, contact_email)
  values (
    uid,
    left(trim(details ->> 'companyName'), 120),
    coalesce(nullif(trim(coalesce(details ->> 'contactEmail', '')), ''), mail)
  )
  on conflict (auth_user_id) do nothing;

  update advertisers set
    company_name  = left(trim(coalesce(details ->> 'companyName', company_name)), 120),
    contact_email = coalesce(nullif(trim(coalesce(details ->> 'contactEmail', '')), ''), contact_email),
    website       = left(trim(coalesce(details ->> 'website', website)), 200),
    description   = left(trim(coalesce(details ->> 'description', description)), 600),
    contact_name  = left(trim(coalesce(details ->> 'contactName', contact_name)), 120),
    contact_phone = left(trim(coalesce(details ->> 'contactPhone', contact_phone)), 32),
    address_line1 = left(trim(coalesce(details ->> 'addressLine1', address_line1)), 160),
    city          = left(trim(coalesce(details ->> 'city', city)), 80),
    postcode      = left(trim(coalesce(details ->> 'postcode', postcode)), 24),
    country       = upper(left(trim(coalesce(details ->> 'country', country)), 2)),
    tax_id        = left(trim(coalesce(details ->> 'taxId', tax_id)), 40),
    profile_updated_at = now()
  where auth_user_id = uid
  returning id into row_id;

  -- A website is a link put in front of every reader who sees the advert, so
  -- it is https or it is not stored. Checked after the write rather than
  -- before, so the message names the field rather than the constraint.
  if exists (
    select 1 from advertisers
    where auth_user_id = uid and website <> '' and website !~* '^https://'
  ) then
    raise exception 'the website has to start with https://' using errcode = '22023';
  end if;

  return jsonb_build_object('id', row_id, 'ok', true);
end;
$function$;

revoke all on function public.save_advertiser_profile(jsonb) from public, anon;
grant execute on function public.save_advertiser_profile(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Keep a company profile somebody actually filled in.
--
-- `mark_browser_account()` runs after every browser sign-in and deletes an
-- untouched advertiser row. "Untouched" meant no campaign and no payment,
-- which was right when the only way to have an advertiser row was the signup
-- trigger. Now that a company profile can be filled in *from the browser*, a
-- row with details in it is plainly touched -- and deleting it on the next
-- sign-in would silently undo the form the user had just completed.
-- ---------------------------------------------------------------------------
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
  -- genuinely untouched: no campaign, no payment, and no company profile that
  -- somebody sat down and filled in.
  delete from advertisers a
  where a.auth_user_id = uid
    and a.profile_updated_at is null
    and not exists (select 1 from campaigns c where c.advertiser_id = a.id)
    and not exists (select 1 from payments p where p.advertiser_id = a.id);
end;
$function$;

revoke all on function public.mark_browser_account() from public, anon;
grant execute on function public.mark_browser_account() to authenticated;
