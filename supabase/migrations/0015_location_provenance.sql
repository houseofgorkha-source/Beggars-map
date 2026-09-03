-- Beggars Map: location provenance + evidence foundation (Stage 2A).
--
-- This is NOT the Google-verification stage. Nothing here enforces Google
-- presence, rejects a listing for lacking one, or auto-corrects a coordinate.
-- It only adds the columns needed to record WHERE a listing's location came
-- from and WHETHER anyone has actually confirmed it — so verification (a
-- later, separate stage) has real provenance data to work from instead of
-- reconstructing it after the fact.
--
-- Two axes, deliberately kept separate (mirrors 0013's source/actor_type
-- split and 0014's reviewed_at/verification_status split — this codebase's
-- established pattern for "don't conflate different kinds of not-yet-known"):
--
--   location_source     — HOW the coordinate was obtained: an explicit human
--                          map pin, raw device GPS, a provider's own
--                          suggestion becoming the actual submitted point, a
--                          pasted link's embedded coordinate, an admin
--                          correction, or a pipeline import. 'unknown' is the
--                          honest value for every listing that predates this
--                          column — never guessed from coordinate precision
--                          or any other indirect signal.
--
--   location_confidence — HOW MUCH that source should be trusted, which is
--                          NOT implied by the source alone (a device_gps fix
--                          taken indoors is low; an admin who walked in and
--                          dropped a pin is human_confirmed). Distinct from
--                          `verification_status` (0013), which is about
--                          price/evidence, not geography.
--
-- provider_place_ids is a single jsonb map (e.g. {"google": "ChIJ...",
-- "ola": "ola-platform:..."}) rather than one column per provider, matching
-- 0014's admin_settings.value precedent: extensible to a future provider with
-- no further migration, and a listing can carry more than one provider's
-- identity at once without a wide sparse column set. Never populated with a
-- guessed id — only ever a real value a caller actually resolved.

alter table listings add column location_source text not null default 'unknown'
  check (location_source in ('user_pin', 'device_gps', 'ola', 'google', 'admin', 'import', 'unknown'));

alter table listings add column location_confidence text not null default 'unknown'
  check (location_confidence in ('unknown', 'low', 'medium', 'high', 'human_confirmed'));

alter table listings add column location_verified_at timestamptz;
alter table listings add column location_verified_by text;
-- Distinct from reviewed_at/reviewed_by (0014, admin triage of the listing as
-- a whole) and from evidence_date (0013, when price evidence was gathered):
-- this specifically means "when did a human last confirm this COORDINATE is
-- right", set only by an explicit verification action, never implied by
-- reviewed_at or by a listing simply being edited.

alter table listings add column provider_place_ids jsonb not null default '{}'::jsonb;
-- Provider identity, never a permanent coordinate. Google Maps Platform's own
-- terms (Service Specific Terms §5.4) permit caching Places API place_id
-- indefinitely but restrict cached lat/lng to 30 days — this column is built
-- to hold exactly the part that's safe to keep. If a Google-derived
-- coordinate is ever needed for a live verification pass, it must be
-- refetched at use time, never written here or into latitude/longitude as a
-- permanent record.

-- ---------------------------------------------------------------------
-- Widen the existing admin-only field lock (0006/0011/0013/0014) to also
-- cover the five columns above. Without this, a listing owner could self-set
-- their own location_confidence to human_confirmed (or clear
-- location_verified_by) via the existing unrestricted "owners can update
-- their own listings" RLS policy — the same gap this trigger already exists
-- to close for every other admin-controlled field.
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
    if new.reviewed_at is distinct from old.reviewed_at then
      new.reviewed_at := old.reviewed_at;
    end if;
    if new.reviewed_by is distinct from old.reviewed_by then
      new.reviewed_by := old.reviewed_by;
    end if;
    if new.location_source is distinct from old.location_source then
      new.location_source := old.location_source;
    end if;
    if new.location_confidence is distinct from old.location_confidence then
      new.location_confidence := old.location_confidence;
    end if;
    if new.location_verified_at is distinct from old.location_verified_at then
      new.location_verified_at := old.location_verified_at;
    end if;
    if new.location_verified_by is distinct from old.location_verified_by then
      new.location_verified_by := old.location_verified_by;
    end if;
    if new.provider_place_ids is distinct from old.provider_place_ids then
      new.provider_place_ids := old.provider_place_ids;
    end if;
  end if;
  return new;
end;
$$;
-- The existing listings_lock_is_hidden trigger already calls this function by
-- name — replacing the body is enough, no need to touch the trigger itself.

-- ---------------------------------------------------------------------
-- Every existing listing (25 in production as of this migration; whatever
-- count exists locally) gets location_source='unknown' and
-- location_confidence='unknown' from the column defaults above — no
-- historical listing's coordinates, location_label, or any other field is
-- touched by this migration. This is deliberate: coordinate DECIMAL
-- PRECISION alone (a real, useful audit signal — see the location-stack
-- architecture investigation) is NOT treated as proof of source here. A
-- 13-decimal coordinate strongly suggests a device/human pin and a
-- 4-decimal one strongly suggests an OLA POI, but "strongly suggests" is not
-- "known" — inferring location_source from precision would be exactly the
-- kind of fabricated provenance this migration's own design brief forbids.
-- Every pre-existing row stays honestly 'unknown' until someone actually
-- re-confirms it.
--
-- The one exception, and it is not an inference: the 7 listings imported by
-- the discovery pipeline's Excel importer (tools/discovery/import-excel.mjs)
-- into PRODUCTION on 2026-09-02 have a place_id that is already recorded,
-- verbatim, in tools/discovery/output/excel-import-state.json
-- (environments.production.entries) — the exact same file 0013's own
-- backfill was verified against. That id is genuinely known, not guessed, so
-- recording it here is not a violation of "don't fabricate" — it's the one
-- case where the true provenance already exists in a file this repo already
-- trusts. location_source is set to 'import' (matching the existing
-- source='import'/actor_type='discovery_pipeline' columns 0013 already set
-- for these same rows) and location_confidence to 'medium': the coordinate
-- is Google-sourced (better than an OLA-only guess) but no human explicitly
-- confirmed the PIN itself — the Excel review step that gated this row's
-- import approved its PRICE qualification, not a site visit confirming the
-- exact lat/lng — so 'human_confirmed' would overclaim what actually
-- happened. See the migration's own commit/PR for this exact reasoning if it
-- needs revisiting.
--
-- Matched by id, not name: these are real production UUIDs (gen_random_uuid()
-- output), so this update matches nothing on any database that doesn't
-- already contain these exact rows — a no-op on a fresh local stack, and
-- inert everywhere except the one production database these ids came from.
update listings set
  location_source = 'import',
  location_confidence = 'medium',
  provider_place_ids = provider_place_ids || jsonb_build_object('google', place_id::text)
from (values
  ('d48e1282-25e8-4be4-8176-6dfaddff6fe5'::uuid, 'ChIJPVjT4aEXrjsR30M6v554zs4'),
  ('41f7daf3-9a31-4bd1-b5d3-be85c912183f'::uuid, 'ChIJYzMFjmptrjsRnowgWZK-Nc8'),
  ('fb3c98bd-6991-4113-8c58-e9111f879350'::uuid, 'ChIJl7SNXBYTrjsRTnFEBO3TqGY'),
  ('1d8f7e99-fdd2-4ecc-901c-e05bf3e8fc01'::uuid, 'ChIJIZ2NLvYXrjsRv1EmIJNh1c8'),
  ('963ae961-2309-4872-ab8e-a89e37261b23'::uuid, 'ChIJTe_TEts_rjsRvIo8Nm9fL28'),
  ('4fc87223-dd60-443d-97ee-1dd878dfeb0b'::uuid, 'ChIJbwqh4okWrjsRpoxhx52qq54'),
  ('ace9609d-5f0a-433c-af08-77b4c3575284'::uuid, 'ChIJwU6gtW49rjsRWLODyUkDOPc')
) as known_imports(id, place_id)
where listings.id = known_imports.id;

-- ---------------------------------------------------------------------
-- INSERT-time protection for the five columns above (remediation for
-- CTO-audit finding C-1, extended to Stage 2A — added 2026-09-03, before
-- this migration has ever been applied anywhere).
--
-- Without this, the same gap C-1 identified for the original 11
-- admin-controlled columns would apply to these five the moment this
-- migration ships: any anonymous/authenticated caller could INSERT a
-- listing already claiming location_confidence='human_confirmed',
-- location_source='admin', a forged location_verified_by, etc.
--
-- This is a SEPARATE function and trigger from
-- lock_listing_admin_fields() (0016), not an extension of it, for a
-- concrete reason discovered while preparing this amendment: 0016 is a
-- migration that already exists, is already approved and committed, and
-- is numbered AFTER this one — so in file-order replay, 0016's own
-- `create or replace function public.lock_listing_admin_fields()`
-- always runs after whatever this file does to the same function name,
-- and completely REPLACES its body. Confirmed empirically against the
-- local stack (which already has both 0015's original content and 0016
-- applied): 0016's replacement body only covers the 11 pre-Stage-2A
-- columns, which means the moment 0016 ran, it silently reverted the
-- UPDATE-time protection this migration's own function replacement
-- above had already established for these five columns — a real,
-- observed regression, not a hypothetical one, reproduced live via a
-- forged owner UPDATE that successfully set location_source='admin' and
-- location_verified_by to an arbitrary value. Amending 0016 to fix this
-- is out of scope for this pass (0016 is already approved and should
-- not be re-opened here); a genuinely independent function/trigger pair
-- sidesteps the conflict entirely; it composes safely with 0016's
-- function since the two touch disjoint columns, and it protects these
-- five columns correctly regardless of whether 0016 has run yet. A
-- future pass MAY consolidate these into one shared function once both
-- are stable in production — not attempted here, to keep this change
-- reviewable and scoped to exactly what it claims to do.
--
-- One function handles both events (TG_OP-branched, same pattern as
-- 0016's own admin-fields function) since, unlike 0016, this needed to
-- both ADD insert-time defaults and RESTORE the update-time revert this
-- migration's own earlier statement already established.

create or replace function public.lock_listing_location_fields()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' then
    if TG_OP = 'INSERT' then
      new.location_source := 'unknown';
      new.location_confidence := 'unknown';
      new.location_verified_at := null;
      new.location_verified_by := null;
      new.provider_place_ids := '{}'::jsonb;
    else
      if new.location_source is distinct from old.location_source then
        new.location_source := old.location_source;
      end if;
      if new.location_confidence is distinct from old.location_confidence then
        new.location_confidence := old.location_confidence;
      end if;
      if new.location_verified_at is distinct from old.location_verified_at then
        new.location_verified_at := old.location_verified_at;
      end if;
      if new.location_verified_by is distinct from old.location_verified_by then
        new.location_verified_by := old.location_verified_by;
      end if;
      if new.provider_place_ids is distinct from old.provider_place_ids then
        new.provider_place_ids := old.provider_place_ids;
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger listings_lock_location_fields
  before insert or update on public.listings
  for each row
  execute function public.lock_listing_location_fields();
