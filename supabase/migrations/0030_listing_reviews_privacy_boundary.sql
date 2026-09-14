-- Beggars Map: listing_reviews privacy boundary, mirroring 0019's exact
-- precedent for votes (security remediation S8 / Batch 5, 2026-09-15).
--
-- 0022's "listing reviews are publicly readable" SELECT policy is
-- `using (true)` with no column restriction -- any anon/authenticated
-- caller can read every row's `created_by`, letting a caller correlate
-- which anonymous-session UUIDs reviewed which listings across the whole
-- site. 0019 built a dedicated view + RPC set specifically to close this
-- exact shape of exposure for `votes`, three days earlier in this schema's
-- history -- this closes the same gap for listing_reviews.
--
-- Confirmed narrow blast radius before writing this: `created_by` is
-- referenced by exactly one client file, web/src/lib/reviews.ts, and by
-- nothing in the mobile app at all (no listing_reviews/listing_review_photos
-- reference anywhere in src/) -- this is a web-only feature. Admin views
-- (ReviewsQueue.tsx, ListingDetail.tsx) read `created_by` through the
-- admin-corrections Edge Function's service-role client, which bypasses
-- RLS/grants entirely and is unaffected by anything below.

-- Table-level access fully revoked, same as votes -- no column-level grant
-- can work here either, for the same reason 0019 documents: the UPDATE
-- policy's USING clause needs to read the EXISTING row's created_by to
-- decide if it matches auth.uid(), which counts as a read requiring SELECT
-- privilege the same way a WHERE clause does.
revoke select, insert, update, delete on public.listing_reviews from anon, authenticated;

-- Public read path: every column except created_by.
create or replace view public.listing_reviews_public as
select id, listing_id, rating, review_text, created_at, updated_at
from public.listing_reviews;

grant select on public.listing_reviews_public to anon, authenticated;

-- Returns the CALLING user's own review for a listing, or zero rows if
-- they haven't reviewed it -- auth.uid() is the only identity ever
-- consulted, so this can never be used to fetch another user's review.
create or replace function public.get_my_review(p_listing_id uuid)
returns table (id uuid, listing_id uuid, rating smallint, review_text text, created_at timestamptz, updated_at timestamptz)
language sql
security definer
set search_path = public
stable
as $$
  select r.id, r.listing_id, r.rating, r.review_text, r.created_at, r.updated_at
  from public.listing_reviews r
  where r.listing_id = p_listing_id
    and r.created_by = auth.uid();
$$;

-- Upserts the CALLING user's own review -- created_by is always auth.uid(),
-- never a client-supplied value, so this can never write as another user.
-- Mirrors submitListingReview()'s existing upsert-on-(listing_id,created_by)
-- shape exactly, just moved server-side.
create or replace function public.upsert_my_review(p_listing_id uuid, p_rating smallint, p_review_text text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  result_id uuid;
begin
  if actor_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  insert into public.listing_reviews (listing_id, created_by, rating, review_text)
  values (p_listing_id, actor_id, p_rating, p_review_text)
  on conflict (listing_id, created_by)
  do update set rating = excluded.rating, review_text = excluded.review_text, updated_at = now()
  returning id into result_id;

  return result_id;
end;
$$;

revoke all on function public.get_my_review(uuid) from public;
revoke all on function public.upsert_my_review(uuid, smallint, text) from public;
grant execute on function public.get_my_review(uuid) to anon, authenticated;
grant execute on function public.upsert_my_review(uuid, smallint, text) to anon, authenticated;

-- listing_review_photos' own INSERT/DELETE policies (0022) checked
-- ownership via `exists (select 1 from listing_reviews r where r.id = ...
-- and r.created_by = auth.uid())` -- a direct read of listing_reviews from
-- inside another table's policy, which needs its own SELECT grant on the
-- referenced column exactly like a WHERE clause does. Since that grant is
-- now fully revoked above, this helper (SECURITY DEFINER, runs as owner)
-- replaces the raw subquery so the calling role only ever needs EXECUTE on
-- the function, not direct table access.
create or replace function public.owns_review(p_review_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.listing_reviews
    where id = p_review_id and created_by = auth.uid()
  );
$$;

revoke all on function public.owns_review(uuid) from public;
grant execute on function public.owns_review(uuid) to anon, authenticated;

drop policy "owners can add photos to their own review" on public.listing_review_photos;
create policy "owners can add photos to their own review" on public.listing_review_photos for insert with check (
  public.owns_review(listing_review_id)
);

drop policy "owners can delete photos from their own review" on public.listing_review_photos;
create policy "owners can delete photos from their own review" on public.listing_review_photos for delete using (
  public.owns_review(listing_review_id)
);
