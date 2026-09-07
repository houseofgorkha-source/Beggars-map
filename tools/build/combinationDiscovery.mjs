/**
 * Pure combination discovery for the SEO sitemap generator.
 *
 * Given a list of "tagged listings" (each with per-dimension tag arrays —
 * see ListingTags / extractListingTags in web/src/lib/extractDimensions.ts),
 * finds every combination of 2+ dimension values that at least `minMatches`
 * REAL listings simultaneously satisfy.
 *
 * Deliberately NOT a blind Cartesian product over every possible dimension
 * value: a candidate combination is only ever proposed if at least one real
 * listing's own tag set actually embodies it (that listing's own
 * cross-product across a chosen subset of ITS OWN non-empty dimensions,
 * never a combination pulled from unrelated listings). Every proposed
 * candidate is then independently re-validated against the FULL listing set
 * to compute the true global intersection count — a combination that no
 * single listing actually embodies is never proposed, and one that fewer
 * than `minMatches` listings actually satisfy is discarded, never included.
 *
 * Zero imports — plain data in, plain data out — so it's unit-testable
 * without touching Supabase or the extraction/keyword logic at all (see
 * tests/combinationDiscovery.test.mjs).
 */

// Canonical dimension ordering — used both to bound per-listing combination
// generation and to produce a stable, order-independent key for dedup (so
// {cuisine, price} and {price, cuisine} discovered from two different
// listings collapse to the same candidate instead of being evaluated twice).
export const DIMENSION_ORDER = ['cuisine', 'mealType', 'dish', 'locality', 'price'];

// Maps the internal dimension names above to the actual query-param names
// useFilterParams.ts and App.tsx read (locality -> location; everything
// else matches 1:1). Kept in this side-effect-free module — rather than in
// generate-sitemap.mjs, which triggers a live Supabase fetch the moment
// it's imported (main() runs at module load) — specifically so this
// mapping can be unit-tested (e.g. "never maps anything to a near-me
// param") without any network access.
export const DIMENSION_TO_PARAM = {
  cuisine: 'cuisine',
  mealType: 'mealType',
  dish: 'dish',
  locality: 'location',
  price: 'price',
};

// Every combination of `size` DISTINCT dimensions chosen from the ones this
// one listing actually has non-empty tags for, crossed with that listing's
// own tag values for each chosen dimension. This is the listing's own
// cross-product — never pulls a tag value from any other listing.
function listingCombinations(tags, size) {
  const availableDimensions = DIMENSION_ORDER.filter((d) => Array.isArray(tags[d]) && tags[d].length > 0);
  if (availableDimensions.length < size) return [];

  const results = [];

  function chooseDimensions(start, chosenDims) {
    if (chosenDims.length === size) {
      let combos = [[]];
      for (const dim of chosenDims) {
        const next = [];
        for (const combo of combos) {
          for (const value of tags[dim]) {
            next.push([...combo, { dim, value }]);
          }
        }
        combos = next;
      }
      results.push(...combos);
      return;
    }
    for (let i = start; i < availableDimensions.length; i++) {
      chooseDimensions(i + 1, [...chosenDims, availableDimensions[i]]);
    }
  }

  chooseDimensions(0, []);
  return results;
}

// Canonical, order-independent string key for a combination (a list of
// {dim, value} pairs), sorted by DIMENSION_ORDER so the same combination
// always produces the same key regardless of which listing proposed it or
// in what order its dimensions were chosen.
export function comboKey(combo) {
  return [...combo]
    .sort((a, b) => DIMENSION_ORDER.indexOf(a.dim) - DIMENSION_ORDER.indexOf(b.dim))
    .map((c) => `${c.dim}=${c.value}`)
    .join('&');
}

// Whether a listing's tags satisfy every {dim, value} pair in a combination
// (AND-intersection — every pair must match, not just one).
export function listingMatchesCombo(tags, combo) {
  return combo.every(({ dim, value }) => Array.isArray(tags[dim]) && tags[dim].includes(value));
}

/**
 * @param {Array<{tags: import('../../web/src/lib/extractDimensions.ts').ListingTags}>} taggedListings
 * @param {{minSize?: number, maxSize?: number, minMatches?: number}} options
 * @returns {Array<{combo: Array<{dim: string, value: string}>, count: number, key: string}>}
 */
export function discoverCombinations(taggedListings, options = {}) {
  const { minSize = 2, maxSize = 3, minMatches = 3 } = options;

  // Candidate combinations: only ones at least one real listing actually
  // embodies (never a theoretical cross-product of unrelated values).
  const candidates = new Map(); // key -> combo array
  for (const { tags } of taggedListings) {
    for (let size = minSize; size <= maxSize; size++) {
      for (const combo of listingCombinations(tags, size)) {
        const key = comboKey(combo);
        if (!candidates.has(key)) candidates.set(key, combo);
      }
    }
  }

  // Re-validate every candidate against the FULL listing set — the true
  // global intersection count, not an assumption from the proposing
  // listing alone.
  const results = [];
  for (const [key, combo] of candidates) {
    const count = taggedListings.filter(({ tags }) => listingMatchesCombo(tags, combo)).length;
    if (count >= minMatches) {
      results.push({ combo, count, key });
    }
  }

  return results;
}
