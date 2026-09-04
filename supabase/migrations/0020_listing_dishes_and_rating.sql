-- Beggars Map: structured dish/price entries + a submitter star rating on
-- listings.
--
-- Product change: Add Listing replaces its single "Price" field with one or
-- more Dish + Price pairs, gains a 1-5 star rating, and relabels "Note" to
-- "Review". The cards and the map popup show the rating and a clickable
-- "Review"; the detail view renders the dishes as a plain-language sentence
-- ("Masala Dosa ₹60, Rice Meals ₹80"), never a table.
--
-- WHY THESE COLUMNS AND NOT THE `reviews` TABLE:
-- `reviews` (0001, restructured by 0005) is a multi-user, one-row-per-user
-- review thread with four NOT NULL category ratings (food_quality, hygiene,
-- availability, maintenance) and no defaults. What's being added here is a
-- single 1-5 rating and a single free-text review supplied by the listing's
-- own author at submission time — a property of the listing row, not a
-- thread. Mapping one star value onto four NOT NULL category columns would
-- mean inventing three ratings the user never gave, and reviving `reviews`
-- would mean re-opening the public SELECT policy 0017 deliberately dropped.
-- `reviews` and `listing_ratings` are therefore left completely untouched
-- (not dropped — see AGENTS.md) and remain available if a real multi-user
-- review feature is ever built. The review TEXT reuses the existing
-- `listings.note` column, which is already public-readable and already
-- rendered on both cards; only its UI label changes.
--
-- price_rupees is deliberately KEPT, not replaced. It stays the cheapest-
-- first sort key (listings_city_price_idx, both apps' order()), the ₹100 cap
-- constraint (0004), and what map pins/list cards/admin/the discovery
-- importer all read. From here on the apps derive it as MIN(dish price) at
-- submission time, so it remains true to the structured data without any
-- consumer needing to change.

-- Source of truth for dish pricing: [{"dish": "...", "price": N}, ...].
-- Nullable with no default and no backfill: every listing that predates this
-- migration keeps exactly the price_rupees it already has and simply has no
-- dish breakdown, which the UI renders as today's plain "₹N". Inventing dish
-- names for those rows would be fabricating data that was never collected.
alter table listings add column dishes jsonb;

-- Validated only when present, so service_role writers that don't supply it
-- (the discovery importer, admin Edge Functions) are unaffected. Mirrors the
-- client-side rules in web/src/lib/dishes.ts and src/lib/dishes.ts: a
-- non-empty array of objects, each with a non-empty dish name and an integer
-- price within the ₹30-₹100 range (2026-09-04 correction — see below).
--
-- A CHECK constraint's own expression can't contain a subquery (Postgres
-- rejects `exists (select ... from jsonb_array_elements(...))` directly in
-- a CHECK with `cannot use subquery in check constraint`, confirmed while
-- writing this) — the per-element validation is pulled out into this
-- IMMUTABLE function instead, which the constraint just calls.
--
-- ₹30 floor (2026-09-04, amending this migration directly rather than
-- adding a new one — 0020 was never applied to production, so it's still
-- safe to amend in place, same as 0015 was before it shipped): the original
-- ₹1 floor let a single cheap item (a ₹10 vada, one roti) pass purely on
-- price, exactly the "Iyer Mess" problem — its own research records
-- Vada ₹10, which must never become a listing's qualifying price. Price
-- range alone still isn't the whole story though — a single item at, say,
-- ₹30-₹100 (Vada ₹30, Idli ₹30, one Roti) must ALSO be rejected; that half
-- of the rule is a text/keyword heuristic (is this dish name a complete
-- meal, or a bare single item?) that doesn't belong in SQL — it's enforced
-- client-side in validateDishDrafts (web/src/lib/dishes.ts,
-- src/lib/dishes.ts), which ports the discovery pipeline's own existing
-- looksLikeCompleteMeal/looksLikeSubstantialDish logic
-- (tools/discovery/matching.mjs) rather than inventing a new one. This
-- function only ever enforces the hard numeric range, matching how the
-- ₹100 cap itself already lived in SQL as a plain number check.
create or replace function public.is_valid_dishes(value jsonb)
returns boolean
language sql
immutable
as $$
  select
    jsonb_typeof(value) = 'array'
    and jsonb_array_length(value) > 0
    and not exists (
      select 1
      from jsonb_array_elements(value) as entry
      where jsonb_typeof(entry) <> 'object'
         or jsonb_typeof(entry -> 'dish') <> 'string'
         or length(trim(entry ->> 'dish')) = 0
         or jsonb_typeof(entry -> 'price') <> 'number'
         or (entry ->> 'price')::numeric <> trunc((entry ->> 'price')::numeric)
         or (entry ->> 'price')::numeric < 30
         or (entry ->> 'price')::numeric > 100
    );
$$;

alter table listings add constraint listings_dishes_shape check (
  dishes is null or public.is_valid_dishes(dishes)
);

-- The submitter's own 1-5 star rating. Nullable: the rating is optional (the
-- review text is optional too), and every pre-existing listing genuinely has
-- no rating — null means "not rated", never "rated zero".
alter table listings add column rating smallint check (rating between 1 and 5);

-- 0017 revoked table-level SELECT on listings from anon/authenticated and
-- replaced it with an explicit column grant, so a newly added column is NOT
-- readable by the public client until it is named here. Both apps'
-- PUBLIC_LISTING_COLUMNS constants are updated to match in the same change.
grant select (dishes, rating) on public.listings to anon, authenticated;

-- Deliberately NOT added to lock_listing_admin_fields (0016): these two are
-- ordinary user-supplied content, exactly like name/note/price_rupees, not
-- admin-controlled provenance fields. Locking them would break the very
-- submission flow they exist for.
