// Pure ranking/selection logic for OLA place predictions (mobile). No native
// modules, no network, no env — extracted out of olaMaps.ts so it can be
// unit-tested directly (see tests/placeRanking.test.mjs at the repo root);
// olaMaps.ts itself imports @maplibre/maplibre-react-native at module load and
// can never be imported outside a React Native runtime.
//
// Deliberately a per-platform copy of web/src/lib/placeRanking.ts rather than a
// shared module: web/ is a separate Vite project with its own tsconfig, and
// this repo already keeps content-moderation duplicated per platform for the
// same reason. Keep the two in sync by hand if the scoring changes.
//
// WHY TYPE RANKING EXISTS ALONGSIDE NAME MATCHING
// ----------------------------------------------
// OLA's autocomplete returns real POIs (`types: food,restaurant`) and
// street-address geocoder artifacts (`types: street_address`) mixed together
// under identical display names. Confirmed live: "Juicy Spot" returns four
// predictions all named "Juicy SPOT", of which only #2 is the restaurant;
// prediction #1 is a street address 1,080 m away. Because the names are
// identical they score identically on name similarity, the tie falls through to
// array order, and OLA's proximity-first ordering hands back the artifact.
//
// Type rank breaks that tie, but only between candidates whose names match
// COMPARABLY WELL (within NAME_TIE_BAND). A clearly better name match still
// wins on name alone, so this never blindly prefers a POI onto a wrong branch.
//
// There is deliberately NO proximity preference: in the Juicy Spot case the
// correct restaurant is the one FARTHER from the search bias point, so
// preferring the nearer candidate would reintroduce the bug.

export type RankablePlace = {
  name: string;
  /** Absent/empty is treated as "unknown", never as an artifact, so a provider
   *  change degrades to today's name-only behaviour. */
  types?: string[];
};

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

/** Sliding-window edit distance, so a candidate with a trailing category or
 *  locality suffix isn't penalised for length. Unchanged behaviour. */
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

export const MIN_MATCH_RATIO = 0.4;
export const NAME_TIE_BAND = 0.05;

export type ScoredPlace<T extends RankablePlace> = {
  place: T;
  ratio: number;
  typeRank: number;
  index: number;
};

export function scorePlaces<T extends RankablePlace>(query: string, places: T[]): ScoredPlace<T>[] {
  return places.map((place, index) => ({
    place,
    index,
    ratio: nameMatchRatio(query, place.name),
    typeRank: placeTypeRank(place.types),
  }));
}

/**
 * Best single candidate, or null when nothing clears the similarity bar.
 * Two-pass and fully deterministic (a banded running comparison would not be
 * transitive, making the winner depend on array order):
 *   1. keep candidates clearing MIN_MATCH_RATIO;
 *   2. keep those within NAME_TIE_BAND of the best ratio;
 *   3. highest type rank, then highest ratio, then earliest.
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
 * Order a whole result list for display. Existing two-group behaviour is kept:
 * everything clearing MIN_MATCH_RATIO first (best first), then everything below
 * it in OLA's own original order rather than forcing a guess on an ambiguous
 * query. Within the good group, ratios are bucketed into NAME_TIE_BAND-wide
 * steps so similarly-matched candidates are separated by type rather than by a
 * meaningless third-decimal difference; bucketing keeps this a total order, so
 * the sort stays deterministic.
 */
export function rankPlaces<T extends RankablePlace>(query: string, places: T[]): T[] {
  return scorePlaces(query, places)
    .sort((a, b) => {
      const aGood = a.ratio >= MIN_MATCH_RATIO;
      const bGood = b.ratio >= MIN_MATCH_RATIO;
      if (aGood !== bGood) return aGood ? -1 : 1;
      if (!aGood) return a.index - b.index;

      const aBucket = Math.round(a.ratio / NAME_TIE_BAND);
      const bBucket = Math.round(b.ratio / NAME_TIE_BAND);
      return bBucket - aBucket || b.typeRank - a.typeRank || b.ratio - a.ratio || a.index - b.index;
    })
    .map((s) => s.place);
}
