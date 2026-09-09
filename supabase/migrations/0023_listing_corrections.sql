-- Beggars Map: user-proposed corrections to a listing's own canonical
-- fields (name, dishes/prices, location) — staged here, invisible to the
-- public beyond the submitter's own rows, and only ever merged into
-- `listings` by an explicit admin approval (a later phase's
-- admin-corrections Edge Function, using the service_role client). This is
-- the enforcement of the product principle that a user submission must
-- never silently overwrite trusted listing data: there is no RLS path from
-- this table into `listings` at all for a non-service_role caller — the
-- lock_listing_admin_fields/lock_listing_location_fields triggers (0016,
-- 0015) already revert any direct attempt on the canonical columns
-- regardless, so an approval can only ever happen through the one
-- privileged path.
--
-- One row per proposed field-group per submission (a single "suggest a
-- correction" form touching both name and dishes creates two rows) so an
-- admin can approve/reject each independently rather than all-or-nothing on
-- a bundled diff.
--
-- No existing "propose -> approve -> merge" table/pattern exists anywhere
-- in this schema (confirmed by reading all prior migrations) — the closest
-- precedents this borrows from are `reports` (insert-only, no public read
-- of others' rows, admin resolves via service-role Edge Function) and
-- `discovery_batch_rows` (0021, an RLS-gated staging table separate from
-- the canonical data it eventually feeds).
create table listing_corrections (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings (id) on delete cascade,
  created_by uuid not null references profiles (id) on delete cascade,
  correction_type text not null check (correction_type in ('name', 'dishes', 'location')),

  -- Only the field(s) matching correction_type are ever populated; the rest
  -- stay null. Kept as one table with nullable per-type columns rather than
  -- three separate tables, since the moderation queue/audit logic (list,
  -- approve, reject, one admin_audit_log entry per row) is identical across
  -- all three types and would otherwise be duplicated three times.
  proposed_name text,
  -- Reuses public.is_valid_dishes() as-is (0020) — the exact same ₹30-₹100
  -- shape validation a real listing's own `dishes` column already enforces,
  -- with zero duplicated logic.
  proposed_dishes jsonb check (proposed_dishes is null or public.is_valid_dishes(proposed_dishes)),
  -- Same range constraints listings.latitude/longitude already carry (0011).
  proposed_latitude double precision check (proposed_latitude is null or proposed_latitude between -90 and 90),
  proposed_longitude double precision check (proposed_longitude is null or proposed_longitude between -180 and 180),
  proposed_location_label text,

  submitter_note text check (submitter_note is null or char_length(submitter_note) <= 300),

  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_at timestamptz,
  reviewed_by text,
  rejection_reason text,

  created_at timestamptz not null default now()
);
create index listing_corrections_pending_idx on listing_corrections (listing_id) where status = 'pending';

alter table listing_corrections enable row level security;

-- Insert-only from the public client's perspective, same posture as
-- `reports`. The one deliberate addition beyond that precedent: a submitter
-- can read back their OWN rows (never anyone else's), so the "Suggest a
-- correction" form can show "you already have a pending correction for
-- this" instead of inviting a duplicate submission. There is no public
-- UPDATE/DELETE policy at all — status only ever transitions via the
-- admin Edge Function's service-role client, which bypasses RLS.
create policy "authenticated users can submit a correction" on listing_corrections for insert with check (
  auth.uid() = created_by
);

create policy "users can view their own submitted corrections" on listing_corrections for select using (
  auth.uid() = created_by
);
