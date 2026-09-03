// Pure ranking/selection logic for OLA place predictions (Deno / Edge
// Function copy). No Deno APIs, no npm imports, no network — deliberately
// dependency-free so the repo's Node test runner can import it directly
// alongside the web and mobile copies (see tests/placeRanking.test.mjs).
//
// This is a per-runtime copy of web/src/lib/placeRanking.ts and
// src/lib/placeRanking.ts, matching this codebase's existing convention of
// duplicating small pure helpers per platform (content moderation does the
// same) rather than reaching across app boundaries. The three copies are kept
// behaviourally identical and every test runs against all three, so they
// cannot silently drift.
//
// WHY TYPE RANKING EXISTS ALONGSIDE NAME MATCHING
// ----------------------------------------------
// OLA's autocomplete returns real POIs (`types: food,restaurant`) and
// street-address geocoder artifacts (`types: street_address`) mixed together
// under identical display names. Confirmed live against the production key:
// "Juicy Spot" returns four predictions all named "Juicy SPOT", of which only
// #2 is the restaurant; prediction #1 is a street address 1,080 m away.
//
// Because the names are identical they score identically on name similarity,
// so the previous implementation here — which kept the first candidate on a
// tie (`ratio > best.ratio`) — returned whichever OLA happened to rank first,
// and OLA ranks by proximity to the bias point. That handed back a street
// address as the resolved coordinate for a pasted share.google link.
//
// Type rank breaks that tie, but only between candidates whose names match
// COMPARABLY WELL (within NAME_TIE_BAND). A clearly better name match still
// wins on name alone, so this never blindly prefers a POI onto a different
// branch of the same chain.
//
// There is deliberately NO proximity preference: in the Juicy Spot case the
// correct restaurant is the one FARTHER from the search bias point, so
// preferring the nearer candidate would reintroduce the exact bug this fixes.

export type RankablePlace = {
  name: string;
  /** Absent/empty is treated as "unknown", never as an artifact, so a provider
   *  change degrades to the previous name-only behaviour. */
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
 * Order a whole result list. Existing two-group behaviour is kept: everything
 * clearing MIN_MATCH_RATIO first (best first), then everything below it in
 * OLA's own original order rather than forcing a guess on an ambiguous query.
 * Within the good group, ratios are bucketed into NAME_TIE_BAND-wide steps so
 * similarly-matched candidates are separated by type rather than by a
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

/**
 * OLA autocomplete prediction → the minimal shape this module ranks.
 *
 * Shared by the Edge Function so the "which fields does a prediction carry"
 * knowledge lives next to the ranking that consumes it. Predictions without
 * usable coordinates or without a name are dropped, matching the filter the
 * Edge Function applied before this module existed.
 */
export type OlaPredictionPoint = RankablePlace & { lat: number; lng: number };

// deno-lint-ignore no-explicit-any
export function predictionsToPoints(predictions: any[]): OlaPredictionPoint[] {
  const points: OlaPredictionPoint[] = [];
  for (const p of predictions ?? []) {
    const lat = p?.geometry?.location?.lat;
    const lng = p?.geometry?.location?.lng;
    const name = p?.structured_formatting?.main_text ?? p?.description ?? '';
    if (typeof lat !== 'number' || typeof lng !== 'number' || !name) continue;
    points.push({ name, lat, lng, types: Array.isArray(p?.types) ? p.types : [] });
  }
  return points;
}
