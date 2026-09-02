-- Beggars Map: launch-day fixes approved 2026-08-30.
--
-- Applied directly via `supabase db query --linked` (not `db push`), same
-- mechanism used for 0010 — the CLI's migration-tracking table doesn't know
-- about any previously-applied migration on this project (see AGENTS.md),
-- so a bare `db push` would fail trying to re-run 0001 from scratch.
--
-- Deliberately excludes two items still pending separate approval:
--   - the 70-char note length cap (one pre-existing seed row is 73 chars)
--   - the reports (listing_id, reported_by, reason) dedupe constraint (one
--     pre-existing duplicate pair exists)
-- Both require a data change first and are being tracked/approved
-- separately rather than bundled into this file.

-- A: owner DELETE policies for listings/reviews (0007 was never actually
-- applied to production — "Delete my listing"/"Delete my review" have been
-- silently no-op'ing for every real user: RLS matches 0 rows, PostgREST
-- reports no error, the UI closes as if it worked).
create policy "owners can delete their own listings" on listings for delete using (auth.uid() = created_by);
create policy "owners can delete their own reviews" on reviews for delete using (auth.uid() = created_by);

-- B1: geo bounds (0 existing violations).
alter table listings add constraint listings_latitude_range_check
  check (latitude between -90 and 90);
alter table listings add constraint listings_longitude_range_check
  check (longitude between -180 and 180);

-- B2: name length cap (longest existing name is 26 chars; UI's own
-- maxLength was bumped to match in AddListingModal.tsx).
alter table listings add constraint listings_name_length_check
  check (char_length(name) <= 120);

-- B5: photo_url restricted to this project's own storage bucket (0 listings
-- have any photo today, so this is a no-op against existing data).
alter table listings add constraint listings_photo_url_bucket_check
  check (photo_url is null or photo_url like 'https://nvingzluboafxzxgxxwc.supabase.co/storage/v1/object/public/listing-photos/%');

-- B6: the moderation-lock trigger 0006 was supposed to add (also never
-- actually applied — today's protection is an accidental side effect of
-- the "listings are publicly readable using (not is_hidden)" SELECT policy
-- being re-checked against PostgREST's implicit RETURNING clause; this
-- makes it an intentional, documented control instead).
create or replace function public.lock_listing_is_hidden()
returns trigger
language plpgsql
as $$
begin
  if new.is_hidden is distinct from old.is_hidden and auth.role() <> 'service_role' then
    new.is_hidden := old.is_hidden;
  end if;
  return new;
end;
$$;

create trigger listings_lock_is_hidden
  before update on public.listings
  for each row
  execute function public.lock_listing_is_hidden();
