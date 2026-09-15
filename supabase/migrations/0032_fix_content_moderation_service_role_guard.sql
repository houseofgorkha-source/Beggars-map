-- Beggars Map: fix check_listing_food_relevance() (0028) to correctly
-- bypass a trusted, JWT-less raw Postgres connection -- same class of fix
-- 0025 already made to 0015's lock_listing_location_fields(), amending an
-- already-production-applied migration's function body via CREATE OR
-- REPLACE in a later migration rather than editing the original file.
--
-- Root cause: 0028 wrote its guard as
--   if auth.role() = 'service_role' then return new; end if;
-- Every OTHER lock/check trigger in this schema (0006, 0011, 0013, 0014,
-- 0015, 0016, 0025, 0027) instead writes
--   if auth.role() <> 'service_role' then <protective action> end if;
-- -- wrapping the PROTECTIVE action in a `<>` check, not gating an early
-- RETURN on `=`. That distinction matters for a raw connection with no
-- PostgREST JWT context (tools/discovery/import-excel.mjs's
-- `supabase db query --linked` writes, and any other direct-SQL admin
-- work), where auth.role() is SQL NULL: `NULL = 'service_role'` and
-- `NULL <> 'service_role'` both evaluate to NULL, and plpgsql's IF treats
-- a NULL condition as false either way -- but a false `<>` guard means the
-- protective action inside it is SKIPPED (the caller is treated as
-- trusted), while a false `=` guard means the early-return bypass is NOT
-- taken (the caller is NOT treated as trusted). 0028 was the one trigger
-- in this schema using the second (`=`, early-return) shape, so it was the
-- one place a raw connection was NOT actually exempted, contrary to its
-- own header comment's claim that "the discovery importer... are
-- unaffected".
--
-- Fix: restructure to the same `<>`-wraps-the-protective-action shape as
-- every other trigger here. No other behavior changes -- identical
-- UPDATE-no-name/note-change bypass, identical word-boundary regex,
-- identical 33-term keyword list, identical exception message/errcode.
-- Anon/authenticated PostgREST callers (auth.role() = 'anon' or
-- 'authenticated', never NULL) are completely unaffected: `'anon' <>
-- 'service_role'` is true either way this guard is written, so moderation
-- still runs for them exactly as before.
--
-- Trigger `listings_check_food_relevance` (0028) already points at this
-- function by name -- CREATE OR REPLACE FUNCTION alone is sufficient, no
-- DROP/CREATE TRIGGER needed.

create or replace function public.check_listing_food_relevance()
returns trigger
language plpgsql
as $$
declare
  combined_text text;
begin
  if auth.role() <> 'service_role' then
    -- Only re-check on UPDATE when name/note actually changed -- otherwise an
    -- unrelated edit (price, dishes, a vote-adjacent trigger touch) to a
    -- pre-existing row that predates this migration could suddenly become
    -- permanently un-updatable if its existing name/note happens to match a
    -- keyword, even though nothing moderation-relevant about that edit
    -- changed. INSERT always checks -- there's no "old" content to compare.
    if TG_OP = 'INSERT' or new.name is distinct from old.name or new.note is distinct from old.note then
      combined_text := lower(coalesce(new.name, '') || ' ' || coalesce(new.note, ''));

      if combined_text ~* '\m(cloth|apparel|fashion|boutique|tailor|garment|salon|spa|parlour|parlor|barber|electronics|mobile shop|laptop|computer repair|furniture|decor|interior design|real estate|property|flat for rent|apartment for rent|pg for rent|gym|fitness|yoga studio|pharmacy|medical store|clinic|hospital|jewelry|jewellery|jeweller|laundry|dry clean|bookstore|stationery|hardware store|paint shop)\M' then
        raise exception 'Beggars Map is for affordable eats only -- this listing does not look food-related.'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  return new;
end;
$$;
