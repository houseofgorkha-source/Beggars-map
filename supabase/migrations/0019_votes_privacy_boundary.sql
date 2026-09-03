-- Beggars Map: votes privacy boundary (remediation P2 — the votes gap
-- explicitly left open by 0017; see that migration's final comment for the
-- original analysis).
--
-- Problem: 0017 could narrow `listings` to a public column list with a
-- plain column-level GRANT, but the same trick doesn't work for `votes`.
-- Postgres requires SELECT privilege on any column referenced in a WHERE
-- clause, not just on columns actually returned — and the app's own
-- "did I vote" check and vote-removal both filter on `created_by`
-- (`.eq('created_by', userId)`). A grant narrow enough to hide
-- `created_by` broke those calls outright (confirmed live: 42501). Left
-- as-is, the pre-existing table-level grant + "votes are publicly
-- readable" policy let any anon/authenticated caller read every
-- (listing_id, created_by) pair for every listing — bulk enumeration of
-- who voted for what, not just "did I vote for this."
--
-- Fix: `votes` gets NO direct grant of any kind to anon/authenticated any
-- more. Aggregate vote counts (the only thing the public UI ever needs to
-- read) come from a new `listing_vote_counts` view that exposes only
-- `listing_id`/`vote_count` — no `created_by`, so there is nothing left to
-- enumerate. A plain column-level grant was tried first and rejected: it
-- covers `supabase.from('votes').select('listing_id', {count, head:true})`
-- fine, but PostgREST's embedded-resource count (`listings?select=...,
-- votes(count)`, what fetchListings() actually used) still requires
-- table-level SELECT to expand — confirmed live (42501), the same
-- wildcard-expansion limitation 0017 already hit for `listings`. A view is
-- a real, separate relation with its own grant, so it isn't subject to
-- that limitation. Every created_by-filtered operation (self-vote check,
-- add, remove) moves to a SECURITY DEFINER RPC that hardcodes auth.uid()
-- as the identity — never a client-supplied user id, so a caller can only
-- ever check/add/remove their OWN vote and can never read anyone else's
-- created_by value. Every existing product behavior (vote count, toggle,
-- self-vote dedupe via the votes table's own primary key) is unchanged.

revoke select, insert, update, delete on public.votes from anon, authenticated;

create or replace view public.listing_vote_counts as
select listing_id, count(*)::int as vote_count
from public.votes
group by listing_id;

grant select on public.listing_vote_counts to anon, authenticated;

-- Returns whether the CALLING user has voted for a listing. Takes no user
-- id parameter — auth.uid() is the only identity ever consulted, so this
-- can never be used to probe another user's vote status.
create or replace function public.has_voted(p_listing_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.votes
    where listing_id = p_listing_id
      and created_by = auth.uid()
  );
$$;

-- Adds the CALLING user's own vote. on conflict do nothing preserves the
-- existing dedupe behavior that used to come from the primary key alone.
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

-- Removes the CALLING user's own vote. Cannot target any other user's row
-- — there is no user id parameter, only auth.uid().
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

revoke all on function public.has_voted(uuid) from public;
revoke all on function public.add_vote(uuid) from public;
revoke all on function public.remove_vote(uuid) from public;
grant execute on function public.has_voted(uuid) to anon, authenticated;
grant execute on function public.add_vote(uuid) to anon, authenticated;
grant execute on function public.remove_vote(uuid) to anon, authenticated;
