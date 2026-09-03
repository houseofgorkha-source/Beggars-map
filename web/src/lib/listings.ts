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
  const { data, error } = await supabase
    .from('listings')
    .select(`${PUBLIC_LISTING_COLUMNS}, votes(count)`)
    .order('price_rupees', { ascending: true })
    .limit(LISTING_FETCH_LIMIT);
  if (error || !data) return { error: error?.message ?? 'Could not load listings.' };
  return { data: data.map((row: any) => ({ ...row, voteCount: row.votes?.[0]?.count ?? 0 })) };
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
    if (error.code === '23505') return { error: "You've already reported this listing for that reason.", duplicate: true };
    return { error: `Could not send report: ${error.message}` };
  }
  return { ok: true };
}
