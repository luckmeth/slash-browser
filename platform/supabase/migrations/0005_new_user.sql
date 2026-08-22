-- An advertiser row for every account, created by the database.
--
-- Done here rather than in the app because the app cannot reliably do it. With
-- email confirmation switched on there is no session immediately after signup,
-- so a client-side insert has no `auth.uid()` to satisfy its own RLS policy;
-- and with Google sign-in the account can appear without the signup form
-- running at all. A trigger on auth.users covers every route in, including ones
-- added later.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
