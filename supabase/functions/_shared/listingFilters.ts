// Shared listing-filter application, used by admin-listings' `list` action
// and its `bulkMarkReviewed` action. Both need to express "every listing
// matching these criteria" — list to display a page of them, bulk-review
// to act on the FULL matching set regardless of pagination — so this is
// one implementation rather than two copies that could quietly drift.
//
// Untyped query parameter deliberately: supabase-js's PostgrestFilterBuilder
// generic type varies by call site and isn't worth importing/fighting here
// for a handful of chained .eq()/.is()/.or() calls — every call site is a
// real query builder object at runtime regardless.

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

// deno-lint-ignore no-explicit-any
export function applyListingFilters(query: any, f: ListingFilters): any {
  let q = query;
  if (f.source) q = q.eq('source', f.source);
  if (f.verificationStatus) q = q.eq('verification_status', f.verificationStatus);
  if (typeof f.isHidden === 'boolean') q = q.eq('is_hidden', f.isHidden);
  if (typeof f.archived === 'boolean') {
    q = f.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null);
  }
  if (typeof f.reviewed === 'boolean') {
    q = f.reviewed ? q.not('reviewed_at', 'is', null) : q.is('reviewed_at', null);
  }
  if (f.search && f.search.trim()) {
    const esc = escapeSearchTerm(f.search);
    if (esc) q = q.or(`name.ilike.%${esc}%,note.ilike.%${esc}%,location_label.ilike.%${esc}%`);
  }
  return q;
}
