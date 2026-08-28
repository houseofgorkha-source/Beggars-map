-- Beggars Map: multi-photo support for the web Add Listing flow, up to 4
-- photos per listing. Additive only — `listings.photo_url` keeps holding
-- the first photo, unchanged, so every existing consumer that only knows
-- about a single photo (list card, info window, listing detail, and the
-- mobile app) keeps working with no changes of its own. Max-4 is enforced
-- client-side, not here — a DB-level cap would need a trigger, which is
-- more machinery than a soft UX limit like this warrants.

create table listing_photos (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings (id) on delete cascade,
  photo_url text not null,
  storage_path text not null,
  position smallint not null default 0,
  created_at timestamptz not null default now()
);
create index listing_photos_listing_idx on listing_photos (listing_id, position);

alter table listing_photos enable row level security;

create policy "listing photos are publicly readable" on listing_photos for select using (true);

create policy "owners can add photos to their own listings" on listing_photos for insert with check (
  exists (select 1 from listings l where l.id = listing_id and l.created_by = auth.uid())
);

create policy "owners can delete photos from their own listings" on listing_photos for delete using (
  exists (select 1 from listings l where l.id = listing_id and l.created_by = auth.uid())
);
