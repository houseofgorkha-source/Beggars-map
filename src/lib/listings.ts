// The one place mobile reads/writes `listings`/`votes`/`reports` —
// extracted so the exact column list (PUBLIC_LISTING_COLUMNS) and query
// shape live in one file instead of being duplicated across MapScreen,
// AddListingScreen and ListingDetailScreen. Remediation plan P6-1/F-2;
// mirrors web/src/lib/listings.ts's interface (same function names/shapes)
// without being the same module — the two apps have separate Supabase
// client instances and separate build systems (see AGENTS.md's existing
// rationale for per-platform copies of small shared logic).
//
// Deliberately narrow: wraps the `listings` table plus the `votes`/
// `reports` mutations that always accompany a listing view. Photo upload
// (storage) and mobile's own live reverse-geocode call stay in their
// screens — genuinely separate concerns, not scope for this module.

import { supabase, PUBLIC_LISTING_COLUMNS } from './supabase';
import type { Listing } from '../types/database';

export type ListingWithVoteCount = Listing & { voteCount: number };

// See web/src/lib/listings.ts's identical constant for the full reasoning:
// a real, explicit bound rather than relying on PostgREST's implicit
// 1000-row truncation.
const LISTING_FETCH_LIMIT = 2000;

export async function fetchListings(): Promise<{ data: ListingWithVoteCount[] } | { error: string }> {
  // Two queries, not a `votes(count)` embed: PostgREST's embedded-resource
  // count needs table-level SELECT on `votes` to expand, which 0019 no
  // longer grants (see that migration for why). `listing_vote_counts` is a
  // public view exposing only the aggregate, no voter identity.
  const [{ data, error }, { data: voteRows }] = await Promise.all([
    supabase.from('listings').select(PUBLIC_LISTING_COLUMNS).order('price_rupees', { ascending: true }).limit(LISTING_FETCH_LIMIT),
    supabase.from('listing_vote_counts').select('listing_id, vote_count'),
  ]);
  if (error || !data) return { error: error?.message ?? 'Could not load listings.' };
  const voteCounts = new Map((voteRows ?? []).map((row: any) => [row.listing_id, row.vote_count as number]));
  return { data: data.map((row: any) => ({ ...row, voteCount: voteCounts.get(row.id) ?? 0 })) };
}

export async function fetchMyListings(userId: string): Promise<{ data: Listing[] } | { error: string }> {
  const { data, error } = await supabase
    .from('listings')
    .select(PUBLIC_LISTING_COLUMNS)
    .eq('created_by', userId)
    .order('created_at', { ascending: false });
  if (error || !data) return { error: error?.message ?? 'Could not load your listings.' };
  return { data: data as unknown as Listing[] };
}

export async function fetchListing(id: string): Promise<{ data: Listing } | { data: null; notFound: true } | { error: string }> {
  const { data, error } = await supabase.from('listings').select(PUBLIC_LISTING_COLUMNS).eq('id', id).maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { data: null, notFound: true };
  return { data: data as unknown as Listing };
}

export type CreateListingInput = {
  created_by: string;
  name: string;
  // Derived from `dishes` (the cheapest entry), never entered directly — it
  // stays the cheapest-first sort key and the ₹100-cap column. See
  // lib/dishes.ts and migration 0020.
  price_rupees: number;
  dishes: { dish: string; price: number }[];
  rating: number | null;
  note: string | null;
  photo_url: string | null;
  latitude: number;
  longitude: number;
  location_source: string;
};

export async function createListing(input: CreateListingInput): Promise<{ ok: true } | { error: string }> {
  const { error } = await supabase.from('listings').insert(input);
  if (error) return { error: error.message };
  return { ok: true };
}

export async function deleteListing(id: string): Promise<{ ok: true } | { error: string }> {
  const { error } = await supabase.from('listings').delete().eq('id', id);
  if (error) return { error: error.message };
  return { ok: true };
}

export async function fetchVoteCount(listingId: string): Promise<number> {
  const { data } = await supabase.from('listing_vote_counts').select('vote_count').eq('listing_id', listingId).maybeSingle();
  return data?.vote_count ?? 0;
}

// userId is unused — kept in the signature so every call site stays
// unchanged. Voter identity is never sent from the client: the RPC checks
// auth.uid() itself, so a caller can only ever learn their OWN vote status
// (see 0019_votes_privacy_boundary.sql for why a direct table read can't
// do this without also exposing every other user's created_by).
export async function hasUserVoted(listingId: string, _userId: string): Promise<boolean> {
  const { data } = await supabase.rpc('has_voted', { p_listing_id: listingId });
  return !!data;
}

export async function toggleVote(listingId: string, _userId: string, currentlyVoted: boolean): Promise<void> {
  if (currentlyVoted) {
    await supabase.rpc('remove_vote', { p_listing_id: listingId });
  } else {
    await supabase.rpc('add_vote', { p_listing_id: listingId });
  }
}

export async function reportListing(listingId: string, userId: string, reason: string): Promise<{ ok: true } | { error: string; duplicate?: boolean }> {
  const { error } = await supabase.from('reports').insert({ listing_id: listingId, reported_by: userId, reason });
  if (error) {
    if (error.code === '23505') return { error: 'You already reported this listing for that reason.', duplicate: true };
    return { error: error.message };
  }
  return { ok: true };
}
