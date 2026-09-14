// Community reviews (listing_reviews / listing_review_photos, migration
// 0022) — separate from `listings.note`/`listings.rating`, the listing's
// own creator's single submission at Add Listing time, which this file
// never touches. Auto-published, not pre-moderated: matches the
// zero-friction posture votes/reports/listing photos already use elsewhere
// in this app (see 0022's own migration header for the full reasoning).
//
// Mirrors lib/listings.ts's shape (thin wrappers around supabase-js calls,
// one file per table-family) rather than folding into that file — reviews
// are a genuinely separate concern from the `listings` row itself.

import { supabase } from './supabase';
import { validateReviewDraft, type ReviewValidation } from './reviewValidation';

export { validateReviewDraft, REVIEW_TEXT_MAX_LENGTH, MAX_REVIEW_PHOTOS } from './reviewValidation';
export type { ReviewValidation };

export type ListingReview = {
  id: string;
  listing_id: string;
  rating: number | null;
  review_text: string | null;
  created_at: string;
  updated_at: string;
  // Ordered by position — merged in client-side from listing_review_photos,
  // same "fetch the parent rows, then batch-fetch photos by id" shape
  // ListingDetailModal already uses for listing_photos.
  photos: string[];
};

const REVIEWS_FETCH_LIMIT = 20;

async function attachPhotos(rows: Omit<ListingReview, 'photos'>[]): Promise<ListingReview[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const { data: photoRows } = await supabase
    .from('listing_review_photos')
    .select('listing_review_id, photo_url, position')
    .in('listing_review_id', ids)
    .order('position', { ascending: true });

  const photosByReview = new Map<string, string[]>();
  for (const p of photoRows ?? []) {
    const list = photosByReview.get(p.listing_review_id) ?? [];
    list.push(p.photo_url);
    photosByReview.set(p.listing_review_id, list);
  }
  return rows.map((r) => ({ ...r, photos: photosByReview.get(r.id) ?? [] }));
}

const REVIEW_COLUMNS = 'id, listing_id, rating, review_text, created_at, updated_at';

// Reads go through listing_reviews_public / the get_my_review RPC rather
// than the listing_reviews table directly (security remediation S8,
// migration 0030) — the table itself has zero grant to anon/authenticated
// any more, mirroring the same privacy boundary 0019 already established
// for votes (created_by is never publicly bulk-enumerable). Writes go
// through the upsert_my_review RPC for the same reason — it hardcodes
// auth.uid() server-side rather than trusting a client-supplied userId.

// Newest-first, capped — same rationale as fetchListings' LISTING_FETCH_LIMIT:
// an explicit bound instead of relying on PostgREST's implicit max_rows
// default. The caller's own review is fetched separately (fetchMyReview)
// rather than assumed to be within this window, since a user's review could
// in principle be older than the most recent 20.
export async function fetchListingReviews(listingId: string): Promise<{ data: ListingReview[] } | { error: string }> {
  const { data, error } = await supabase
    .from('listing_reviews_public')
    .select(REVIEW_COLUMNS)
    .eq('listing_id', listingId)
    .order('created_at', { ascending: false })
    .limit(REVIEWS_FETCH_LIMIT);
  if (error) return { error: error.message };
  return { data: await attachPhotos(data ?? []) };
}

export async function fetchMyReview(listingId: string, _userId: string): Promise<ListingReview | null> {
  const { data } = await supabase.rpc('get_my_review', { p_listing_id: listingId });
  const row = data?.[0];
  if (!row) return null;
  const [withPhotos] = await attachPhotos([row]);
  return withPhotos;
}

// Upserts on (listing_id, created_by) — a second submission from the same
// user edits their own review in place rather than creating a duplicate
// (see 0022's unique constraint). Does not touch photos; the caller uploads
// and inserts listing_review_photos rows separately, same two-step shape
// AddListingModal already uses for a listing's own extra photos.
export async function submitListingReview(input: {
  listingId: string;
  userId: string;
  rating: number | null;
  reviewText: string | null;
}): Promise<{ id: string } | { error: string }> {
  const { data, error } = await supabase.rpc('upsert_my_review', {
    p_listing_id: input.listingId,
    p_rating: input.rating,
    p_review_text: input.reviewText,
  });
  if (error || !data) return { error: error?.message ?? 'Could not submit your review.' };
  return { id: data };
}
