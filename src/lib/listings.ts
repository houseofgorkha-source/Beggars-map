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
  const { data, error } = await supabase
    .from('listings')
    .select(`${PUBLIC_LISTING_COLUMNS}, votes(count)`)
    .order('price_rupees', { ascending: true })
    .limit(LISTING_FETCH_LIMIT);
  if (error || !data) return { error: error?.message ?? 'Could not load listings.' };
  return { data: data.map((row: any) => ({ ...row, voteCount: row.votes?.[0]?.count ?? 0 })) };
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
  price_rupees: number;
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
  const { count } = await supabase.from('votes').select('*', { count: 'exact', head: true }).eq('listing_id', listingId);
  return count ?? 0;
}

export async function hasUserVoted(listingId: string, userId: string): Promise<boolean> {
  const { data } = await supabase.from('votes').select('listing_id').eq('listing_id', listingId).eq('created_by', userId).maybeSingle();
  return !!data;
}

export async function toggleVote(listingId: string, userId: string, currentlyVoted: boolean): Promise<void> {
  if (currentlyVoted) {
    await supabase.from('votes').delete().eq('listing_id', listingId).eq('created_by', userId);
  } else {
    await supabase.from('votes').insert({ listing_id: listingId, created_by: userId });
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
