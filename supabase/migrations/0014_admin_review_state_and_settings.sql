-- Beggars Map: admin "reviewed" triage state + a minimal settings table.
--
-- This is deliberately NOT the same concept as `verification_status`
-- (0013): verification_status is about whether a listing's PRICE/EVIDENCE
-- has been confirmed accurate; `reviewed_at` here is about whether an
-- admin has ever triaged/looked at the listing in the moderation queue at
-- all. A listing can be reviewed (an admin looked at it, decided it's
-- fine) while still verification_status='unverified' (nobody has done the
-- price-evidence legwork yet) — conflating the two columns would make
-- both meanings fuzzy, so this stays a separate column, mirroring the
-- existing reports.resolved_at / reports.resolved_by pattern exactly
-- (nullable timestamp = pending; a companion text column records who).

alter table listings add column reviewed_at timestamptz;
alter table listings add column reviewed_by text;
-- null reviewed_at = "new/unreviewed" (the state the admin UI's NEW
-- indicator keys off). Set only by an explicit admin mark-reviewed action
-- or a discovery-pipeline import that opts into auto-review (see
-- admin_settings below) — never implicitly by viewing a listing.

-- ---------------------------------------------------------------------
-- Widen admin_audit_log's action list to cover the two new explicit
-- actions this feature adds. Postgres has no "add value to check
-- constraint" — drop and recreate with the longer list.
-- ---------------------------------------------------------------------
alter table admin_audit_log drop constraint admin_audit_log_action_check;
alter table admin_audit_log add constraint admin_audit_log_action_check
  check (action in (
    'create', 'import', 'edit', 'hide', 'unhide', 'archive', 'unarchive',
    'resolve_report', 'mark_reviewed', 'mark_unreviewed'
  ));

-- ---------------------------------------------------------------------
-- Minimal generic settings store — one row so far (whether future
-- discovery-pipeline imports default to already-reviewed), but shaped as
-- a small key/value table rather than a bespoke column so a second
-- genuinely-needed setting later doesn't require another migration. This
-- is the smallest structure that lets the setting be read AND changed
-- from the admin UI itself (an env var/secret would need CLI/dashboard
-- access to change, which defeats the point of it being an admin-facing
-- control) — not a general settings framework.
-- ---------------------------------------------------------------------
create table admin_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table admin_settings enable row level security;
-- Zero policies — service-role only, same posture as admin_audit_log.
-- No immutability trigger here (unlike admin_audit_log): a setting is
-- meant to be changed, that's its entire purpose.

insert into admin_settings (key, value) values
  ('import_default_reviewed', 'false'::jsonb);
-- Default: future discovery-pipeline imports always require review
-- (reviewed_at stays null on import) until an admin explicitly opts in
-- to auto-review via the admin UI.

-- Review-tracking baseline: the moment this feature started existing in
-- THIS environment, captured once, here, at apply time — never
-- recomputed, never touched again by this or any other migration. It
-- answers a UI question ("should this listing's un-reviewed-ness show up
-- as a NEW badge?"), not a data-integrity one — it draws zero conclusions
-- about whether any listing was actually looked at.
--
-- The "is new" predicate this baseline supports is:
--   reviewed_at IS NULL AND created_at > review_tracking_baseline
-- A listing created before the baseline that has never been reviewed
-- stays exactly that — reviewed_at NULL, reviewed_by NULL, genuinely
-- unreviewed — it simply isn't flagged as NEW, because "new" here means
-- "arrived after we started tracking this," not "reviewed_at happens to
-- be null." See _shared/listingFilters.ts, the single place this
-- predicate is implemented.
--
-- Local resets naturally get a fresh baseline for free: `now()` here
-- means "whenever this migration next actually runs," so a from-scratch
-- local replay always ends up with review-tracking starting at replay
-- time, with zero explicit backfill step required.
insert into admin_settings (key, value) values
  ('review_tracking_baseline', to_jsonb(now()));

-- ---------------------------------------------------------------------
-- Extend the existing admin-only field lock (0013) to also cover
-- reviewed_at/reviewed_by — without this, a listing owner could self-
-- mark their own listing "reviewed" via the existing unrestricted
-- "owners can update their own listings" RLS policy, exactly the gap
-- this trigger already exists to close for every other admin-controlled
-- field.
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
  end if;
  return new;
end;
$$;
-- Same trigger (listings_lock_is_hidden, 0006/0011) already calls this
-- function by name — replacing the body is enough.

-- No backfill of listings.reviewed_at/reviewed_by. Every existing row
-- keeps its true, honest state: nobody has reviewed it, so both columns
-- stay NULL — exactly the same "we don't actually know / it didn't
-- happen" discipline already used elsewhere (evidence_date is never
-- guessed; 0013's own backfill used actor_type='unknown' rather than
-- inventing an actor). Manufacturing a reviewed_at timestamp here would
-- assert a review event that never occurred. The review_tracking_baseline
-- setting above is what keeps these rows out of the NEW queue instead —
-- a UI-layer decision, not a claim written into the row's own data.
