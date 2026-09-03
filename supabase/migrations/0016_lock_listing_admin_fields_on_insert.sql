-- Beggars Map: lock admin-controlled listing columns on INSERT, not just
-- UPDATE (remediation for CTO-audit finding C-1, 2026-09-03).
--
-- The existing lock trigger (0006, widened by 0011/0013/0014) is
-- `BEFORE UPDATE` only. The public INSERT policy
-- ("authenticated users can create listings", 0001) has no column
-- restriction beyond `auth.uid() = created_by` — so any anonymous or
-- authenticated caller could previously INSERT a listing that already
-- claims `verification_status='human_verified'`, `source='admin'`,
-- `reviewed_at` already set (which also removes it from the admin NEW
-- queue before anyone ever triages it), etc. Confirmed live against
-- production 2026-09-03 that no BEFORE INSERT trigger of any kind exists
-- on `listings`.
--
-- This migration is scoped to exactly the 11 admin-controlled columns
-- that exist in production TODAY: is_hidden, archived_at,
-- verification_status, source, actor_type, actor_label, evidence_url,
-- evidence_date, last_modified_by, reviewed_at, reviewed_by. It
-- deliberately does NOT reference the 5 Stage 2A location-provenance
-- columns (location_source, location_confidence, location_verified_at,
-- location_verified_by, provider_place_ids) — those only exist where
-- 0015 has been applied (local only, not production), and this function
-- is a trigger on `listings` that fires on every single INSERT/UPDATE, so
-- referencing a column that doesn't exist yet on production's `listings`
-- would break ordinary listing creation there the moment this file is
-- applied. Extending this same lock to the location_* columns is a
-- separate, already-planned step (amending 0015 itself, before 0015 is
-- ever deployed anywhere) and is explicitly out of scope for this file.
--
-- Rename, not a new function: `ALTER FUNCTION ... RENAME TO` changes the
-- catalog name only — Postgres trigger definitions bind to a function's
-- OID, not its name, so the existing `listings_lock_is_hidden` BEFORE
-- UPDATE trigger (created in 0006, untouched here) keeps firing the same
-- underlying function with no changes needed on the trigger side. The old
-- name (`lock_listing_is_hidden`) undersold what the function does even
-- before this change — it already locked 11 columns, not just
-- `is_hidden` — so this is also the moment to give it an accurate name.
--
-- The UPDATE branch below is copied verbatim from 0014's version of this
-- function (the last replacement that only covered these 11 columns,
-- before 0015 added the location_* checks) — behaviourally unchanged.
-- The INSERT branch is new: there is no `old` row on INSERT, so instead
-- of "revert to the previous value" it forces every admin-controlled
-- column to its true schema default for any non-service_role caller,
-- regardless of what the caller supplied. service_role (the admin Edge
-- Functions and the discovery importer) is unaffected either way — the
-- `auth.role() <> 'service_role'` guard already exempts it.

alter function public.lock_listing_is_hidden()
  rename to lock_listing_admin_fields;

create or replace function public.lock_listing_admin_fields()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' then
    if TG_OP = 'INSERT' then
      new.is_hidden := false;
      new.archived_at := null;
      new.verification_status := 'unverified';
      new.source := 'user';
      new.actor_type := 'user';
      new.actor_label := null;
      new.evidence_url := null;
      new.evidence_date := null;
      new.last_modified_by := null;
      new.reviewed_at := null;
      new.reviewed_by := null;
    else
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
    end if;
  end if;
  return new;
end;
$$;
-- The existing listings_lock_is_hidden BEFORE UPDATE trigger (0006) already
-- calls this function by OID — the rename above is enough, no need to touch
-- that trigger.

create trigger listings_lock_admin_fields_insert
  before insert on public.listings
  for each row
  execute function public.lock_listing_admin_fields();
