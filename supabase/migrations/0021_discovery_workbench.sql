-- Beggars Map: Discovery Workbench — transient, batch-scoped working storage
-- for remote intern review of discovery candidates.
--
-- This is NOT a permanent second copy of the discovery dataset. The single
-- source of truth remains the local WIP xlsx
-- (tools/discovery/output/candidates-...workonprogress.xlsx) and the local
-- tools/discovery/photos/<place_id>/ folders, both on the owner's own disk.
-- The owner pushes one batch of not-yet-reviewed candidates in here (via
-- tools/discovery/workbench-sync.mjs, a later phase), an intern reviews them
-- through a hosted page, and the owner pulls the results back into the local
-- xlsx/photos and purges this table/bucket. See the approved plan's Section
-- B2 for the capacity math behind the batch-size default (50) and the 2MB
-- per-photo cap below — Storage, not database rows, is the binding
-- constraint on the free tier.
--
-- RLS is enabled with zero policies for anon/authenticated. Every read/write
-- is meant to go through the discovery-workbench Edge Function's
-- service-role client, which bypasses RLS entirely — there is no legitimate
-- direct-from-browser access path, so unlike listings (0017's column-level
-- grant), no public column list is needed here at all.
--
-- This table does NOT rely on the "no default grant" finding 0008 recorded
-- for the original 0001-0007 tables — verified directly against this local
-- stack while writing this migration that a freshly created public-schema
-- table here actually DOES pick up full default SELECT/INSERT/UPDATE/DELETE
-- privileges for anon/authenticated (evidently this local Postgres image's
-- default-privileges configuration changed at some point since 0008 was
-- written — that comment is no longer accurate for new tables and should
-- not be relied on). RLS-with-zero-policies is therefore the actual,
-- load-bearing protection here, not a redundant second layer: confirmed
-- live that an anon-key SELECT against this table returns 200 with an empty
-- array (RLS silently filters every row) and an anon-key INSERT is
-- rejected, despite the table-level GRANT existing underneath both.
create table public.discovery_batch_rows (
  place_id text primary key,

  -- Read-only reference fields, copied verbatim from the WIP xlsx at push
  -- time. Never edited by the intern.
  name text not null,
  formatted_address text,
  latitude double precision,
  longitude double precision,
  primary_type text,
  business_status text,
  google_price_level text,
  website_uri text,
  google_maps_uri text,
  discovery_sources text,

  -- Intern-editable fields.
  phone text,
  -- Exact 3 values already in use in the real WIP workbook's own Excel
  -- data-validation dropdown ("Yes,No, No Answer") — not a 4th "Invalid"
  -- option, which was never a real option in the source file.
  number_valid text check (number_valid is null or number_valid in ('Yes', 'No', 'No Answer')),
  -- Exact string import-excel.mjs already requires for its qualifying gate.
  menu_list_under_100 text check (menu_list_under_100 is null or menu_list_under_100 in ('Yes', 'No')),
  -- Reuses public.is_valid_dishes() as-is (0020_listing_dishes_and_rating.sql)
  -- — a plain, table-agnostic function on a jsonb value, so this table
  -- shares the exact same ₹30-₹100/shape validation with zero duplicated
  -- logic.
  dishes jsonb check (dishes is null or public.is_valid_dishes(dishes)),
  -- Derived server-side from `dishes` via the same formatDishes() sentence
  -- convention ("Masala Dosa ₹60, Rice Meals ₹80") the production app uses
  -- — not free-typed by the intern. See the plan's Section J for the open
  -- question about whether a free-text fallback is still needed.
  notes text,

  -- Batch bookkeeping.
  batch_id text not null,
  pushed_at timestamptz not null default now(),
  -- Bumped on every update — seeds a cheap future optimistic-concurrency
  -- check (reject if the client's last-seen updated_at doesn't match) once
  -- a second intern is real. Not enforced yet with exactly one intern.
  updated_at timestamptz not null default now()
);

alter table public.discovery_batch_rows enable row level security;
-- Deliberately no policies and no GRANT to anon/authenticated — see header.

create index discovery_batch_rows_batch_id_idx on public.discovery_batch_rows (batch_id);

-- Private bucket — unlike the public listing-photos bucket (0002/0018),
-- discovery photos are unpublished review material, never publicly served.
-- All reads go through short-lived signed URLs minted by the Edge
-- Function's service-role client; all writes go through signed upload URLs
-- the same function mints, never through anon/authenticated storage
-- policies. 2MB per file (not 5MB, matching listing-photos) because these
-- are review reference images, not the final production photos a listing
-- gets on import — see the plan's Section B2 for the worst-case-storage
-- math this cap is bounding.
insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values ('discovery-photos', 'discovery-photos', false, array['image/jpeg', 'image/png', 'image/webp'], 2097152)
on conflict (id) do nothing;
-- No storage.objects policies for anon/authenticated — same reasoning as
-- the table above.
