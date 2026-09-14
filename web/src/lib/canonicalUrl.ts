// Pure canonical-URL decision logic, extracted out of App.tsx's metaTags
// useMemo so it's independently testable (see tests/canonicalUrl.test.mjs).
//
// Security/SEO remediation S6 (2026-09-15): previously the canonical <link>
// was hardcoded to the homepage everywhere -- every one of the sitemap's
// ~30 filter/landing URLs declared itself a duplicate of the homepage,
// which search engines generally won't index separately from the page its
// own canonical points at. Deliberately narrow, not "canonicalize every
// query parameter": self-canonicalize only when exactly ONE of the five
// dimension filters is active -- that's the shape of the vast majority of
// the sitemap's own URLs (addSingleDim in tools/build/generate-sitemap.mjs).
// Zero filters (the homepage) or two-or-more filters active at once (a
// combination the sitemap only includes selectively, gated on a live
// >=3-listings threshold this module has no cheap way to replicate)
// canonicalize to the homepage instead of guessing.

export const CANONICAL_ORIGIN = 'https://budgetmap.in';

export interface CanonicalFilters {
  cuisine?: string;
  mealType?: string;
  dish?: string;
  location?: string;
  price?: string;
}

export function computeCanonicalUrl(filters: CanonicalFilters, search: string): string {
  const activeFilterCount = [filters.cuisine, filters.mealType, filters.dish, filters.location, filters.price].filter(Boolean).length;
  return activeFilterCount === 1 ? `${CANONICAL_ORIGIN}/${search}` : `${CANONICAL_ORIGIN}/`;
}
