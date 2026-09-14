-- Beggars Map: server-side rate limiting on the two highest-value anonymous
-- write paths (security remediation S2 / Batch 4, 2026-09-15).
--
-- TRADEOFF, stated up front per the remediation instruction: this app has
-- no existing Edge Function fronting listing/review creation (both go
-- directly through PostgREST from the client, by design -- see
-- web/src/lib/listings.ts/reviews.ts), and introducing one now purely for
-- rate limiting would be a real architecture change, not the smallest safe
-- fix. A DB-level trigger + lightweight tracking table instead enforces the
-- limit at the exact same layer every other fix in this remediation pass
-- already uses (the lock triggers, the content-moderation check) -- it
-- cannot be bypassed by calling PostgREST directly, requires no new
-- external service, and needs zero client-code changes.
--
-- SCOPE, deliberately narrow: only `listings` (permanent, public,
-- highest-damage spam target) and `listing_reviews` (public, persistent
-- text) are covered here. `votes` already has strong per-user dedup (one
-- vote per listing, enforced by primary key) which caps its own spam
-- value; `reports`/`listing_corrections` are invisible to the public
-- (admin-queue-only impact) and lower severity. Extending this same table/
-- function to those paths later is straightforward if needed -- not done
-- in this pass, reported as a known remaining gap rather than rushed.
--
-- Also explicitly NOT a substitute for: (a) Supabase Auth's own anonymous-
-- sign-in rate limit, which caps how fast new identities can be minted in
-- the first place -- this repo has never been able to confirm that
-- dashboard toggle's current state (no dashboard access from any agent
-- session, per AGENTS.md's own long-standing note); (b) Cloudflare/Vercel
-- edge-level abuse protection, out of scope for a database migration.
-- This migration only bounds how many listings/reviews any SINGLE already-
-- authenticated session (anonymous or real) can create in a rolling
-- window, regardless of how that session was obtained.

create table public.rate_limit_events (
  id bigint generated always as identity primary key,
  actor uuid not null,
  action text not null,
  created_at timestamptz not null default now()
);

-- The only query pattern this table ever serves: "how many rows for this
-- (actor, action) in the last N minutes" -- indexed exactly for that.
create index rate_limit_events_actor_action_created_idx
  on public.rate_limit_events (actor, action, created_at desc);

-- No table-level grant to anon/authenticated at all, and RLS enabled with
-- zero policies -- same "service-role/SECURITY DEFINER only" posture as
-- discovery_batch_rows (0021)/admin_audit_log (0013). The enforcement
-- function below is SECURITY DEFINER specifically so ordinary callers never
-- need direct access to this table to be rate-limited by it.
alter table public.rate_limit_events enable row level security;

-- Reusable across any table: the action name and thresholds are trigger
-- arguments (TG_ARGV), not hardcoded, so extending this to another table
-- later is a one-line `create trigger` away.
create or replace function public.enforce_write_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  action_name text := TG_ARGV[0];
  max_per_window int := TG_ARGV[1]::int;
  window_minutes int := TG_ARGV[2]::int;
  recent_count int;
begin
  -- service_role (admin tooling, the discovery importer) is never rate
  -- limited -- same guard used by every other trigger in this schema.
  -- actor_id is null for a bare-anon-key caller with no user JWT at all,
  -- which shouldn't be reachable for these two tables' own INSERT policies
  -- (both require auth.uid() = created_by, which is null-safe already),
  -- but this guard avoids ever recording a null-actor row regardless.
  if auth.role() = 'service_role' or actor_id is null then
    return new;
  end if;

  select count(*) into recent_count
  from public.rate_limit_events
  where actor = actor_id
    and action = action_name
    and created_at > now() - make_interval(mins => window_minutes);

  if recent_count >= max_per_window then
    raise exception 'Too many submissions -- please wait a few minutes before trying again.'
      using errcode = 'P0001';
  end if;

  insert into public.rate_limit_events (actor, action) values (actor_id, action_name);
  return new;
end;
$$;

-- Thresholds are a starting point, not a precisely-tuned final value --
-- generous enough to not interfere with a real user adding a couple of
-- listings/reviews in one sitting, tight enough to meaningfully slow a
-- scripted flood. Revisit with real traffic data if needed.
create trigger listings_rate_limit
  before insert on public.listings
  for each row
  execute function public.enforce_write_rate_limit('listing_create', '8', '10');

create trigger listing_reviews_rate_limit
  before insert on public.listing_reviews
  for each row
  execute function public.enforce_write_rate_limit('review_create', '10', '10');
