// Pure ranking/selection logic for OLA place predictions. No network, no env,
// no DOM — extracted out of olaPlaces.ts so it can be unit-tested directly
// (see tests/placeRanking.test.mjs at the repo root).
//
// WHY THIS EXISTS BEYOND NAME MATCHING
// -----------------------------------
// OLA's autocomplete mixes two genuinely different kinds of record into one
// response under identical display names: real POIs (`types: food,restaurant`)
// and street-address geocoder artifacts (`types: street_address`). Confirmed
// live against the production key: the query "Juicy Spot" returns FOUR
// predictions all named "Juicy SPOT" — #1, #3 and #4 are street_address, and
// only #2 is the actual restaurant. Prediction #1 sits 1,080 m from the real
// place, #3 is 2,727 m away and #4 is 7,834 m away.
//
// Name similarity alone cannot separate those: all four names are identical,
// so they score identically, the tie falls through to array order, and OLA's
// proximity-first ranking wins — handing back a street address as if it were
// the restaurant. That coordinate then flows straight into a stored listing.
//
// The fix is that `types` — which OLA already returns and which this codebase
// previously discarded on the floor — breaks the tie. Deliberately scoped:
// type rank only decides between candidates whose names match COMPARABLY WELL
// (within NAME_TIE_BAND). A clearly better name match always wins outright,
// whatever its type, so this can never "blindly prefer a POI" and drag a
// selection onto a different branch of the same chain.
//
// Note there is deliberately NO proximity preference here. It would be the
// obvious-looking guard and it is exactly wrong for this data: in the Juicy
// Spot case the CORRECT restaurant is the one FARTHER from the search bias
// point, so preferring the nearer candidate would reintroduce the bug.

export type RankablePlace = {
  name: string;
  /** OLA's own `types` array. Optional: absent/empty is treated as "unknown",
   *  never as an artifact, so a provider change or an older cached shape
   *  degrades to today's name-only behaviour instead of silently ranking
   *  everything last. */
  types?: string[];
};

// A prediction carrying any of these is a real place someone can walk into.
const POI_TYPES = new Set([
  'food',
  'restaurant',
  'cafe',
  'bakery',
  'bar',
  'meal_takeaway',
  'meal_delivery',
  'store',
  'establishment',
  'point_of_interest',
]);

// A prediction carrying ONLY these is a geocoder artifact — an address or an
// administrative area, not a business.
const ADDRESS_TYPES = new Set([
  'street_address',
  'route',
  'geocode',
  'intersection',
  'postal_code',
  'plus_code',
  'locality',
  'sublocality',
  'neighborhood',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
]);

export const TYPE_RANK_POI = 2;
export const TYPE_RANK_UNKNOWN = 1;
export const TYPE_RANK_ADDRESS = 0;

/** 2 = a real POI, 1 = unknown/other, 0 = a pure address/area artifact. */
export function placeTypeRank(types?: string[]): number {
  if (!types || types.length === 0) return TYPE_RANK_UNKNOWN;
  if (types.some((t) => POI_TYPES.has(t))) return TYPE_RANK_POI;
  if (types.every((t) => ADDRESS_TYPES.has(t))) return TYPE_RANK_ADDRESS;
  return TYPE_RANK_UNKNOWN;
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

/** How closely a candidate's name matches the query — a sliding window the
 *  length of the query, minimum edit distance over all positions, so a
 *  candidate with extra trailing text (a category or locality suffix) isn't
 *  unfairly penalised for length. Unchanged from the original implementation. */
export function nameMatchRatio(query: string, name: string): number {
  const normalizedQuery = normalize(query);
  const candidate = normalize(name);
  if (!normalizedQuery || !candidate) return 0;

  let distance: number;
  if (candidate.length <= normalizedQuery.length) {
    distance = levenshtein(normalizedQuery, candidate);
  } else {
    distance = Infinity;
    for (let i = 0; i <= candidate.length - normalizedQuery.length; i++) {
      distance = Math.min(distance, levenshtein(normalizedQuery, candidate.slice(i, i + normalizedQuery.length)));
    }
  }
  return 1 - distance / normalizedQuery.length;
}

/** Minimum name similarity before a candidate is considered at all. */
export const MIN_MATCH_RATIO = 0.4;

/** Two candidates whose name ratios differ by no more than this are treated as
 *  "similarly matched", and `types` decides between them. Anything beyond it is
 *  a materially better name match and wins on name alone. */
export const NAME_TIE_BAND = 0.05;

export type ScoredPlace<T extends RankablePlace> = {
  place: T;
  ratio: number;
  typeRank: number;
  index: number;
};

/** Score every candidate, preserving original order in `index`. */
export function scorePlaces<T extends RankablePlace>(query: string, places: T[]): ScoredPlace<T>[] {
  return places.map((place, index) => ({
    place,
    index,
    ratio: nameMatchRatio(query, place.name),
    typeRank: placeTypeRank(place.types),
  }));
}

/**
 * The single best candidate for `query`, or null when nothing clears the name
 * similarity bar (a genuinely ambiguous query returns null rather than a bad
 * guess — unchanged contract).
 *
 * Selection is a two-pass, fully deterministic order rather than a running
 * comparison, because a banded comparison is not transitive and would make the
 * winner depend on array order:
 *   1. keep only candidates clearing MIN_MATCH_RATIO;
 *   2. take the best name ratio, keep everything within NAME_TIE_BAND of it;
 *   3. among those, highest type rank wins, then highest ratio, then earliest.
 */
export function bestPlaceMatch<T extends RankablePlace>(query: string, places: T[]): T | null {
  if (!normalize(query)) return null;

  const eligible = scorePlaces(query, places).filter((s) => s.ratio >= MIN_MATCH_RATIO);
  if (eligible.length === 0) return null;

  const topRatio = Math.max(...eligible.map((s) => s.ratio));
  const contenders = eligible.filter((s) => s.ratio >= topRatio - NAME_TIE_BAND);

  contenders.sort(
    (a, b) => b.typeRank - a.typeRank || b.ratio - a.ratio || a.index - b.index
  );

  return contenders[0].place;
}

/**
 * Order a whole result list for display, keeping the existing two-group
 * behaviour: everything clearing MIN_MATCH_RATIO first (best first), then
 * everything below it in OLA's own original order rather than forcing a guess.
 *
 * Within the good group, ratios are bucketed into NAME_TIE_BAND-wide steps so
 * that "similarly matched" candidates are compared on type instead of on a
 * meaningless third-decimal difference. Bucketing (rather than a banded
 * comparator) keeps this a proper total order, so the sort is stable and
 * deterministic.
 */
export function rankPlaces<T extends RankablePlace>(query: string, places: T[]): T[] {
  return scorePlaces(query, places)
    .sort((a, b) => {
      const aGood = a.ratio >= MIN_MATCH_RATIO;
      const bGood = b.ratio >= MIN_MATCH_RATIO;
      if (aGood !== bGood) return aGood ? -1 : 1;
      if (!aGood) return a.index - b.index; // neither clears the bar — keep OLA's order

      const aBucket = Math.round(a.ratio / NAME_TIE_BAND);
      const bBucket = Math.round(b.ratio / NAME_TIE_BAND);
      return bBucket - aBucket || b.typeRank - a.typeRank || b.ratio - a.ratio || a.index - b.index;
    })
    .map((s) => s.place);
}
