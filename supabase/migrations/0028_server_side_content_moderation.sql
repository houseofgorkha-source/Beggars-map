-- Beggars Map: server-side enforcement of the food-relevance content check
-- (security remediation S4/Batch 2, 2026-09-15).
--
-- checkFoodRelevance() (web/src/lib/contentModeration.ts, duplicated
-- byte-for-byte at src/lib/contentModeration.ts) is a client-side-only
-- keyword check against listings.name + listings.note. Nothing server-side
-- ever re-checks this -- a direct REST call (bypassing both apps' UI
-- entirely) could previously insert a listing named e.g. "Cheap Salon
-- Services" and it would go live immediately (is_hidden defaults false).
--
-- This ports the exact same 33-term keyword list into a BEFORE INSERT OR
-- UPDATE trigger on `listings`, scoped to name+note (identical scope to the
-- client check -- this does not expand into `dishes`, which is bounded by
-- its own separate is_valid_dishes()/₹30-100 CHECK already). Same
-- auth.role() <> 'service_role' guard used everywhere else in this schema,
-- so the discovery importer and admin corrections (both service-role) are
-- unaffected -- confirmed the importer's own connection carries no
-- PostgREST JWT context, so auth.role() reads NULL there, same mechanism
-- already relied on for the other lock triggers.
--
-- Ported with WORD-BOUNDARY matching (\m...\M), not the client's raw
-- substring `.includes()` -- the client-side version is fine for that
-- (a human sees and can dismiss a wrong client-side rejection before ever
-- submitting), but a server-side hard reject needs to actually not
-- misfire: "cloth" as a bare substring would match inside a real business
-- name containing that string as a word-fragment (e.g. a hypothetical
-- "Clothilde's Cafe"), which \m/\M (Postgres regex word-boundary anchors)
-- avoids by requiring the matched term to be a whole word/phrase, not an
-- arbitrary substring. Every term in this list is a plain word or space-
-- separated phrase with no regex metacharacters, so this substitution is
-- safe with no other escaping needed. Multi-word phrases ("mobile shop",
-- "real estate", etc.) work correctly under this scheme too, since the
-- \m/\M anchors sit at the OUTER edges of the whole phrase.

create or replace function public.check_listing_food_relevance()
returns trigger
language plpgsql
as $$
declare
  combined_text text;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  -- Only re-check on UPDATE when name/note actually changed -- otherwise an
  -- unrelated edit (price, dishes, a vote-adjacent trigger touch) to a
  -- pre-existing row that predates this migration could suddenly become
  -- permanently un-updatable if its existing name/note happens to match a
  -- keyword, even though nothing moderation-relevant about that edit
  -- changed. INSERT always checks -- there's no "old" content to compare.
  if TG_OP = 'UPDATE' and new.name is not distinct from old.name and new.note is not distinct from old.note then
    return new;
  end if;

  combined_text := lower(coalesce(new.name, '') || ' ' || coalesce(new.note, ''));

  if combined_text ~* '\m(cloth|apparel|fashion|boutique|tailor|garment|salon|spa|parlour|parlor|barber|electronics|mobile shop|laptop|computer repair|furniture|decor|interior design|real estate|property|flat for rent|apartment for rent|pg for rent|gym|fitness|yoga studio|pharmacy|medical store|clinic|hospital|jewelry|jewellery|jeweller|laundry|dry clean|bookstore|stationery|hardware store|paint shop)\M' then
    raise exception 'Beggars Map is for affordable eats only -- this listing does not look food-related.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger listings_check_food_relevance
  before insert or update on public.listings
  for each row
  execute function public.check_listing_food_relevance();
