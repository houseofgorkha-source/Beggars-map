// Shared listing-filter application AND the single definition of "is this
// listing NEW" — used by admin-listings' `list`/`get`/`bulkMarkReviewed`
// actions and admin-dashboard's unreviewedListings count. All of them need
// the exact same predicate; this is the one place it's implemented so it
// can never drift between call sites (see the review-state design note in
// 0014_admin_review_state_and_settings.sql for the full rationale).
//
// "NEW" is deliberately NOT just `reviewed_at IS NULL` — that would also
// flag every pre-existing listing that predates this feature, none of
// which were ever actually reviewed under the old workflow either. The
// review_tracking_baseline setting (set once, at migration-apply time,
// never touched again) draws the line: a listing only counts as NEW if
// it's both unreviewed AND arrived after tracking started.
//
// SUPABASE_URL isn't imported here — this module only ever receives an
// already-authenticated adminClient from its caller (see
// _shared/adminAuth.ts), matching every other _shared module's pattern.

import { SupabaseClient } from 'npm:@supabase/supabase-js@2';

function escapeSearchTerm(term: string): string {
  // `,` and `(`/`)` have structural meaning in PostgREST's `.or()` filter
  // syntax — strip them rather than let a search term accidentally alter
  // the shape of the filter. `%`/`_` are ILIKE wildcards — escape them so
  // a literal percent sign in a search term is matched literally.
  return term
    .replace(/[,()]/g, ' ')
    .replace(/[%_]/g, '\\$&')
    .trim();
}

export type ListingFilters = {
  source?: string;
  verificationStatus?: string;
  isHidden?: boolean;
  archived?: boolean;
  reviewed?: boolean;
  search?: string;
};

// Read once per request (callers doing several queries in one invocation
// — e.g. admin-dashboard's stats — should fetch this once and pass it to
// every call that needs it, not re-query per call).
export async function getReviewTrackingBaseline(adminClient: SupabaseClient): Promise<string> {
  const { data, error } = await adminClient
    .from('admin_settings')
    .select('value')
    .eq('key', 'review_tracking_baseline')
    .maybeSingle();
  if (error || !data) {
    throw new Error('review_tracking_baseline setting is missing — was 0014 applied?');
  }
  return data.value as string;
}

export function isListingNew(listing: { reviewed_at: string | null; created_at: string }, baseline: string): boolean {
  return listing.reviewed_at === null && listing.created_at > baseline;
}

// deno-lint-ignore no-explicit-any
export function applyListingFilters(query: any, f: ListingFilters, baseline: string): any {
  let q = query;
  if (f.source) q = q.eq('source', f.source);
  if (f.verificationStatus) q = q.eq('verification_status', f.verificationStatus);
  if (typeof f.isHidden === 'boolean') q = q.eq('is_hidden', f.isHidden);
  if (typeof f.archived === 'boolean') {
    q = f.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null);
  }
  if (typeof f.reviewed === 'boolean') {
    // "reviewed" filter maps onto the NEW predicate, not raw reviewed_at:
    // false -> NEW (unreviewed AND post-baseline); true -> literally
    // reviewed_at IS NOT NULL (a real review actually happened) — pre-
    // baseline legacy rows with a null reviewed_at fall into neither
    // bucket when explicitly filtered, which is correct: they were never
    // reviewed, but they're also not part of the NEW queue. Bulk-review's
    // "filtered"/"all" modes reuse this exact branch (by passing
    // `reviewed: false` themselves) so "mark all new" can never sweep up
    // a legacy listing that isn't part of the NEW queue.
    q = f.reviewed ? q.not('reviewed_at', 'is', null) : q.is('reviewed_at', null).gt('created_at', baseline);
  }
  if (f.search && f.search.trim()) {
    const esc = escapeSearchTerm(f.search);
    if (esc) q = q.or(`name.ilike.%${esc}%,note.ilike.%${esc}%,location_label.ilike.%${esc}%`);
  }
  return q;
}
