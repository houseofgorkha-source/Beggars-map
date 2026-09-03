-- Beggars Map: public data boundary (remediation for CTO-audit finding
-- C-2, and the reviews/listing_ratings half of C-8).
--
-- listings: the public SELECT policy (0001) is row-level only
-- (`using (not is_hidden)`) and places no column restriction, and both
-- apps' queries used `select('*')` — so every admin/internal/provenance
-- column (reviewed_by, last_modified_by, actor_label, source,
-- verification_status, evidence_url, evidence_date, archived_at,
-- updated_at, and, as of 0015, the five location_* columns) was returned
-- to any public request. Confirmed live 2026-09-03: an anonymous
-- `select=name,reviewed_by` request returned the real admin email
-- (houseofgorkha@gmail.com) on every reviewed listing.
--
-- Fixed here with a Postgres column-level GRANT rather than a view:
-- `revoke select` + `grant select (<public columns>)` requires no new
-- database object and, critically, needs no RLS changes at all — the
-- existing row-level policy (`not is_hidden`) keeps working exactly as
-- before; this only narrows which COLUMNS of an already-visible row come
-- back. The public column list below is exactly what both apps' UI code
-- actually reads (see web/src/lib/supabase.ts and src/lib/supabase.ts,
-- both export PUBLIC_LISTING_COLUMNS mirroring this grant, and both apps'
-- Listing TypeScript type was narrowed to match).
--
-- Important nuance discovered while implementing this, worth recording:
-- `select('*')` is NOT quietly narrowed to whatever columns are granted —
-- PostgreSQL requires TABLE-level SELECT to expand the `*` wildcard at
-- all, so a `select('*')` query under a column-level-only grant fails
-- outright with `permission denied for table listings`, not a partial
-- result. Confirmed directly against a real Postgres connection (not
-- just via PostgREST) before relying on it. This is why the accompanying
-- app-code change replaces every `select('*'...)` on `listings` with an
-- explicit column list — a real (small, mechanical) client change, not
-- the "zero client changes" this stage's remediation plan originally
-- assumed before this was tested.
revoke select on public.listings from anon, authenticated;
grant select (
  id, created_by, name, note, price_rupees, photo_url,
  latitude, longitude, city, created_at, location_label
) on public.listings to anon, authenticated;

-- reviews: the entire feature has been removed from both apps' UI (see
-- AGENTS.md — StarRating.tsx deleted from both platforms, the schema is
-- kept only for possible future use) but the public SELECT policy from
-- 0001 was never removed, so it was still returning real free-text
-- comments and author ids to any anonymous request. The table and its
-- rows are left completely alone (not dropped, not truncated) — this
-- only removes public read access to a feature with zero live UI
-- consumers on either platform. If reviews are ever reintroduced, this
-- policy is exactly what a future migration would need to re-add.
drop policy "reviews are publicly readable" on public.reviews;

-- listing_ratings (the aggregate view over reviews, 0005): closing the
-- base table's own RLS-governed policy above does not automatically close
-- this — as a view it carries its own independent grant, confirmed
-- directly (anon/authenticated held full INSERT/SELECT/UPDATE/DELETE on
-- it, evidently from Supabase's own default privileges on newly-created
-- public-schema relations, not from anything in this repo's migrations).
-- Revoked outright rather than narrowed to a column subset: every column
-- this view has (avg_rating, rating_count) is itself derived from the
-- same dead review data the policy above just closed off, so there is no
-- "safe" partial view of it to keep.
revoke select on public.listing_ratings from anon, authenticated;

-- votes: NOT addressed by this migration. Confirmed during implementation
-- that a column-level grant cannot solve this the way it solved
-- `listings` above — PostgreSQL requires SELECT privilege on a column to
-- reference it in a WHERE clause, not just to return it, and the app's
-- own "did I vote" check (`.eq('created_by', userId)`) filters on
-- `created_by` without returning it. Restricting the grant to
-- `listing_id` only breaks that check outright (confirmed live: `42501
-- permission denied for table votes`); granting both columns leaves the
-- exact bulk-enumeration exposure this would exist to close, since
-- Postgres column privileges gate readability, not "readable only when
-- filtered to your own row" — that needs either a code change (e.g. an
-- RPC/security-definer check replacing the direct filtered SELECT) or a
-- view, neither of which is in this migration's scope. Left as a known,
-- reported gap rather than a silently-incomplete fix.
