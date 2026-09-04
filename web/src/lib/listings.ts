// The one place web reads/writes `listings`/`votes`/`reports` — extracted
// so the exact column list (PUBLIC_LISTING_COLUMNS) and query shape live in
// one file instead of being duplicated across App.tsx, AddListingModal.tsx
// and ListingDetailModal.tsx. Remediation plan P6-1/F-2: this exists
// specifically so a future change to what's public (or what's queried)
// only needs one edit, not a grep across components — which is exactly the
// gap that let 0017's admin-column leak (C-2) go unnoticed for as long as
// it did.
//
// Deliberately narrow: this wraps the `listings` table itself, plus the
// `votes`/`reports` mutations that always accompany a listing view. Photo
// upload (storage, not this table) and location-provenance/reverse-geocode
// resolution stay in AddListingModal.tsx — genuinely separate concerns,
// not scope for this module.

import { supabase, PUBLIC_LISTING_COLUMNS } from './supabase';
import type { Listing } from '../types';

export type ListingWithVoteCount = Listing & { voteCount: number };

// A real cap, not a stylistic one: PostgREST truncates any unbounded query
// at 1000 rows (config.toml's max_rows) with no error and no indication —
// the map/list would just silently stop showing listings past that point.
// 2000 is comfortably above today's 25 while still being a real, explicit
// bound instead of relying on that implicit server-side default. A genuine
// viewport/bounding-box query (only load what's on-screen) is a larger,
// product-behavior-changing piece of work — today's list panel
// deliberately shows every listing in the city at once — and is out of
// scope here; see the remediation plan's P6-4+ items.
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
  location_label: string | null;
  location_source: string;
};

export async function createListing(input: CreateListingInput): Promise<{ id: string } | { error: string }> {
  const { data, error } = await supabase.from('listings').insert(input).select('id').single();
  if (error || !data) return { error: error?.message ?? 'Could not create listing.' };
  return { id: data.id };
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
    if (error.code === '23505') return { error: "You've already reported this listing for that reason.", duplicate: true };
    return { error: `Could not send report: ${error.message}` };
  }
  return { ok: true };
}
