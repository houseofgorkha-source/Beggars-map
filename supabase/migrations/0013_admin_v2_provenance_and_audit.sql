-- Beggars Map: Admin v2 provenance model + audit log.
--
-- Additive only — no existing column's type/meaning changes, no existing
-- RLS policy is touched, no existing consumer (mobile, web, the public
-- listings/reports RLS surface) is affected. This lays the schema
-- foundation for the admin panel rebuild; no Edge Function or UI code is
-- part of this migration.
--
-- Two deliberately separate provenance axes on `listings` (do not merge
-- them back into one column):
--   `source`      — what KIND of record this is: 'user' | 'admin' | 'import' | 'legacy'.
--                    'legacy' is the honest fallback for a record whose real
--                    origin can't be confidently established — never guessed
--                    into 'import' or 'user' just to fill the column.
--   `actor_type` / `actor_label` — WHO/WHAT actually acted, when known.
--                    'user' rows lean on the existing `created_by` FK for
--                    identity (actor_label stays null — no duplication).
--                    'admin' rows get the admin's verified email in
--                    actor_label. 'discovery_pipeline' rows get a fixed
--                    process label. 'unknown' (legacy rows) gets neither,
--                    rather than fabricating an attribution.
--
-- `evidence_date` is kept separate from `created_at`/`updated_at` on
-- purpose: it means "when the underlying research/evidence was gathered",
-- never "when this row entered Beggars Map's database". It is left NULL
-- wherever that distinct date isn't actually recorded anywhere (checked
-- against tools/discovery/output/excel-import-state.json for the 7
-- production-imported rows during this migration's own backfill below —
-- it only records `imported_at`, which duplicates `created_at`'s meaning,
-- not a separate evidence-gathering date, so NULL is the honest value
-- there too, not a guess).

-- ---------------------------------------------------------------------
-- listings: provenance + verification + archive + modification tracking
-- ---------------------------------------------------------------------

alter table listings add column source text not null default 'user'
  check (source in ('user', 'admin', 'import', 'legacy'));

alter table listings add column actor_type text not null default 'user'
  check (actor_type in ('user', 'admin', 'discovery_pipeline', 'unknown'));

alter table listings add column actor_label text;
-- populated only for actor_type in ('admin', 'discovery_pipeline');
-- null for 'user' (created_by already identifies them) and 'unknown'.

alter table listings add column evidence_url text;
alter table listings add column evidence_date date;

alter table listings add column verification_status text not null default 'unverified'
  check (verification_status in ('unverified', 'pending_review', 'human_verified', 'rejected'));

alter table listings add column archived_at timestamptz;
-- null = active. Set alongside is_hidden=true by an "archive" admin action
-- (archiving always hides); unarchiving clears archived_at only — it does
-- NOT clear is_hidden, which requires a separate, explicit "unhide".

alter table listings add column updated_at timestamptz not null default now();
-- bumped by a trigger below on ANY update, by any caller — a general
-- "last touched" timestamp, not admin-specific.

alter table listings add column last_modified_by text;
-- admin's verified email; set ONLY by admin-tool writes (a future Edge
-- Function), never by a public user's own self-edit of their listing via
-- the existing "owners can update their own listings" RLS path.

-- ---------------------------------------------------------------------
-- reports: who resolved a report group
-- ---------------------------------------------------------------------

alter table reports add column resolved_by text;
-- admin's verified email, matching the identity representation used
-- everywhere else in this feature (text/email, not a profiles FK — admins
-- authenticate via a separate flow and aren't guaranteed a profiles row).

-- ---------------------------------------------------------------------
-- admin_audit_log: append-only record of admin-tool actions
-- ---------------------------------------------------------------------

create table admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('admin', 'discovery_pipeline')),
  actor_label text not null,
  -- admin's verified email, or 'discovery-pipeline' for the production
  -- importer. Never a fabricated identity — see the importer-wiring note
  -- in AGENTS.md/the admin v2 plan for how the pipeline populates this.
  action text not null check (action in (
    'create', 'import', 'edit', 'hide', 'unhide', 'archive', 'unarchive', 'resolve_report'
  )),
  -- no 'delete' yet — v2 ships hide/unhide/archive/unarchive only.
  target_type text not null check (target_type in ('listing', 'report')),
  target_id uuid not null,
  before_state jsonb,
  after_state jsonb,
  request_metadata jsonb,
  created_at timestamptz not null default now()
);

alter table admin_audit_log enable row level security;
-- Deliberately zero policies — not even a service-role-scoped one is
-- needed, since service_role bypasses RLS entirely. No anon/authenticated
-- grant exists for this table at all (see 0008's grant list, which this
-- table is intentionally excluded from). Matches, and is stricter than,
-- the existing `reports` table's own "service-role-only" read posture.

-- Immutability: even a service-role caller cannot UPDATE or DELETE an
-- audit row. This is enforced at the database level, not left as an
-- application-code convention, because RLS alone can't stop service_role
-- (which bypasses RLS by definition) from mutating history.
create or replace function public.prevent_admin_audit_log_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'admin_audit_log records are immutable and cannot be updated or deleted';
end;
$$;

create trigger admin_audit_log_immutable
  before update or delete on public.admin_audit_log
  for each row
  execute function public.prevent_admin_audit_log_mutation();

-- ---------------------------------------------------------------------
-- Widen the existing is_hidden lock trigger to cover every new
-- admin-controlled field. Without this, a listing owner could self-edit
-- their own verification_status/source/archived_at/etc. via the existing
-- unrestricted "owners can update their own listings" RLS policy, which
-- would defeat the point of these fields being admin-controlled.
-- `updated_at` is deliberately NOT locked — see its own trigger below.
-- ---------------------------------------------------------------------

create or replace function public.lock_listing_is_hidden()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' then
    if new.is_hidden is distinct from old.is_hidden then
      new.is_hidden := old.is_hidden;
    end if;
    if new.archived_at is distinct from old.archived_at then
      new.archived_at := old.archived_at;
    end if;
    if new.verification_status is distinct from old.verification_status then
      new.verification_status := old.verification_status;
    end if;
    if new.source is distinct from old.source then
      new.source := old.source;
    end if;
    if new.actor_type is distinct from old.actor_type then
      new.actor_type := old.actor_type;
    end if;
    if new.actor_label is distinct from old.actor_label then
      new.actor_label := old.actor_label;
    end if;
    if new.evidence_url is distinct from old.evidence_url then
      new.evidence_url := old.evidence_url;
    end if;
    if new.evidence_date is distinct from old.evidence_date then
      new.evidence_date := old.evidence_date;
    end if;
    if new.last_modified_by is distinct from old.last_modified_by then
      new.last_modified_by := old.last_modified_by;
    end if;
  end if;
  return new;
end;
$$;
-- The existing `listings_lock_is_hidden` trigger (created in 0006/0011)
-- already calls this function by name — replacing the function body is
-- enough, no need to drop/recreate the trigger itself.

-- General "last touched" timestamp — bumps for every update, any caller,
-- unlike the admin-only fields above.
create or replace function public.set_listing_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger listings_set_updated_at
  before update on public.listings
  for each row
  execute function public.set_listing_updated_at();

-- ---------------------------------------------------------------------
-- Backfill existing rows using only directly-verifiable signals — never
-- a guess. All three steps are name/id matches against exact, confirmed
-- values; nothing here infers provenance from timing, counts, or any
-- other indirect signal.
-- ---------------------------------------------------------------------

-- Step 1: the 7 rows created by the Beggars Map Discovery pipeline's
-- Excel importer (documented in tools/discovery/output/excel-import-state.json;
-- names matched exactly as stored, verified by direct query, including
-- the comma in the FlavourFusionCuisine name).
update listings set
  source = 'import',
  actor_type = 'discovery_pipeline',
  actor_label = 'discovery-pipeline'
where created_by = '00000000-0000-0000-0000-000000000001'
  and name in (
    'Eat Fit Punjabi Dhaba',
    'FlavourFusionCuisine(Chinese & Momo), Electronic City Phase 1',
    'Sri Udupi Swaad restaurant and lodging',
    'RAJANNA MILITARY HOTEL TATANAGAR',
    'Sri Veerabhadreshwara Mess',
    'New K V Canteen',
    'Raithana Aramane'
  );

-- Step 2: the older discovery-pipeline local integration-test row
-- ("Iyer Mess", id 54c014ce-1743-4b2a-afe8-f6d477c5668e per AGENTS.md).
-- Local-only — this id will simply match nothing if this migration is
-- later applied to production. Classified as 'import' rather than
-- 'legacy' because its origin (the discovery pipeline) IS documented and
-- known, even though its stored evidence is stale/superseded — that's a
-- verification_status/data-quality concern, not a provenance one.
update listings set
  source = 'import',
  actor_type = 'discovery_pipeline',
  actor_label = 'discovery-pipeline'
where id = '54c014ce-1743-4b2a-afe8-f6d477c5668e';

-- Step 3: everything else still attributed to the fixed seed/team profile
-- is either one of the 5 known 0003_seed_demo_listings.sql rows, or any
-- other stray row on that same profile this migration doesn't otherwise
-- know how to classify. Either way its origin is not a real organic user
-- submission, so it must not fall through to the 'user' column default —
-- 'legacy' is the correct, honest bucket per this pass's explicit
-- instruction to keep the 5 seed/demo rows as legacy.
update listings set
  source = 'legacy',
  actor_type = 'unknown',
  actor_label = null
where created_by = '00000000-0000-0000-0000-000000000001'
  and source = 'user'; -- i.e. not already reclassified by steps 1/2 above
