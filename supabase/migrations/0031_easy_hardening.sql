-- Beggars Map: low-risk hardening items from the security audit (Batch 7,
-- 2026-09-15) that don't warrant their own dedicated migration.

-- 1. listing_corrections had no length cap on its two free-text columns,
-- unlike listings.name's own 120-char cap (0011). Read-only production
-- check before writing this: max observed proposed_name is 25 chars, max
-- proposed_location_label is 28 -- both far under these caps, zero
-- existing rows at risk. proposed_name matches listings.name's own limit
-- exactly (a correction proposing a new name should obey the same bound
-- the canonical field does); proposed_location_label gets a more generous
-- 200, matching the "Street, Area" descriptor shape used elsewhere.
alter table public.listing_corrections add constraint listing_corrections_proposed_name_length_check
  check (proposed_name is null or char_length(proposed_name) <= 120);

alter table public.listing_corrections add constraint listing_corrections_proposed_location_label_length_check
  check (proposed_location_label is null or char_length(proposed_location_label) <= 200);

-- 2. add_vote/remove_vote (0019) never got the explicit `set search_path =
-- public` that has_voted (same migration, same file) has -- not currently
-- exploitable (every identifier inside both functions is already schema-
-- qualified), but inconsistent hardening worth normalizing for defense in
-- depth, matching the audit's own note.
create or replace function public.add_vote(p_listing_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.votes (listing_id, created_by)
  values (p_listing_id, auth.uid())
  on conflict (listing_id, created_by) do nothing;
$$;

create or replace function public.remove_vote(p_listing_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.votes
  where listing_id = p_listing_id
    and created_by = auth.uid();
$$;
