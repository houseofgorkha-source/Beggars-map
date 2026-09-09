-- Beggars Map: community reviews (rating + text + photos), separate from
-- listings.rating/listings.note (the listing's own creator's single
-- submission at Add Listing time, untouched by this migration).
--
-- WHY A NEW TABLE AND NOT THE OLD `reviews` TABLE (0001/0005): `reviews` is
-- a four-category-rating thread (food_quality/hygiene/availability/
-- maintenance, all NOT NULL, no defaults) whose public SELECT policy 0017
-- deliberately dropped, and whose UI was removed entirely per AGENTS.md.
-- Reviving it would mean re-opening that policy and inventing three ratings
-- a community reviewer never gave. `listing_reviews` is a fresh, minimal
-- shape instead: one optional 1-5 rating, one optional short review, one
-- row per (listing, user).
--
-- Auto-published, not pre-moderated (explicit product decision): matches
-- the zero-friction posture already used for votes/reports/listing photos
-- elsewhere in this app. Abuse is handled reactively, by an admin deleting
-- an individual review after the fact (see the admin-corrections Edge
-- Function, a later phase) — there is no pending/approval status on this
-- table, unlike listing_corrections below.
create table listing_reviews (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings (id) on delete cascade,
  created_by uuid not null references profiles (id) on delete cascade,
  rating smallint check (rating between 1 and 5),
  review_text text check (review_text is null or char_length(review_text) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per (listing, user): a second submission from the same session
  -- is an edit of their own review (via upsert), not a second review. This
  -- is what "multiple user reviews possible, no one overwriting another"
  -- actually means at the row level — different users each get their own
  -- row; the same user editing their own opinion is expected, not a bug.
  unique (listing_id, created_by),
  constraint listing_reviews_not_empty check (rating is not null or review_text is not null)
);
create index listing_reviews_listing_idx on listing_reviews (listing_id, created_at desc);

alter table listing_reviews enable row level security;

create policy "listing reviews are publicly readable" on listing_reviews for select using (true);

create policy "authenticated users can create their own review" on listing_reviews for insert with check (
  auth.uid() = created_by
);

-- Required for the upsert-your-own-review flow (submitListingReview does an
-- upsert on (listing_id, created_by), which needs UPDATE privilege on a
-- conflict). No public DELETE policy: removing a review is an admin-only
-- action (via the service-role client, which bypasses RLS), same as
-- listings' own is_hidden/delete posture for abuse cases.
create policy "owners can update their own review" on listing_reviews for update using (
  auth.uid() = created_by
);

-- Photos attached to a community review. Reuses the existing public
-- `listing-photos` storage bucket (0002/0018) rather than a new one — same
-- jpeg/png/webp/5MB constraints already enforced there, uploaded under
-- `${userId}/reviews/${reviewId}/...` so the bucket's existing owner-prefix
-- storage policy (keyed on the leading `${userId}/` path segment) already
-- covers these uploads with no new storage.objects policy required.
create table listing_review_photos (
  id uuid primary key default gen_random_uuid(),
  listing_review_id uuid not null references listing_reviews (id) on delete cascade,
  photo_url text not null,
  storage_path text not null,
  position smallint not null default 0,
  created_at timestamptz not null default now()
);
create index listing_review_photos_review_idx on listing_review_photos (listing_review_id, position);

alter table listing_review_photos enable row level security;

create policy "listing review photos are publicly readable" on listing_review_photos for select using (true);

create policy "owners can add photos to their own review" on listing_review_photos for insert with check (
  exists (select 1 from listing_reviews r where r.id = listing_review_id and r.created_by = auth.uid())
);

create policy "owners can delete photos from their own review" on listing_review_photos for delete using (
  exists (select 1 from listing_reviews r where r.id = listing_review_id and r.created_by = auth.uid())
);
