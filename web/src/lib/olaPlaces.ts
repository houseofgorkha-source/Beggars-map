// Place/landmark search only — OLA Places autocomplete. Map rendering is
// Google Maps JS API (see googleMaps.ts); this file has no rendering
// responsibility, unlike the pre-migration olaMaps.ts it's revived from
// (that also had vectorStyleUrl/transformRequest/staticMapUrl for MapLibre
// tiles, none of which apply now).
const OLA_BASE = 'https://api.olamaps.io';
const apiKey = import.meta.env.VITE_OLA_MAPS_API_KEY as string | undefined;

export type PlaceSuggestion = {
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
};

export async function searchPlaces(query: string, near?: { latitude: number; longitude: number }): Promise<PlaceSuggestion[]> {
  if (!apiKey || !query.trim()) return [];

  const params = new URLSearchParams({ input: query, api_key: apiKey });
  if (near) params.set('location', `${near.latitude},${near.longitude}`);

  const response = await fetch(`${OLA_BASE}/places/v1/autocomplete?${params.toString()}`);
  if (!response.ok) return [];

  const data = await response.json();
  const predictions: any[] = data.predictions ?? [];

  return predictions
    .map((p) => ({
      placeId: p.place_id as string,
      name: (p.structured_formatting?.main_text ?? p.description ?? '') as string,
      address: (p.structured_formatting?.secondary_text ?? '') as string,
      latitude: p.geometry?.location?.lat as number,
      longitude: p.geometry?.location?.lng as number,
    }))
    .filter((p) => typeof p.latitude === 'number' && typeof p.longitude === 'number');
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function levenshtein(a: string, b: string): number {
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

// Same approach as supabase/functions/resolve-maps-link/index.ts's own
// bestPlaceMatch (duplicated rather than shared — that one runs in Deno
// server-side, this runs in the browser, same as this codebase's existing
// per-platform content-moderation duplication). OLA's own ranking for a
// bare text query weighs proximity to the bias point over name match
// (confirmed live: "Juicy Spot" biased near Bengaluru center returned an
// unrelated street address as prediction #1, with the real "Juicy SPOT"
// restaurant only at #2) — so callers that need "the prediction that's
// actually named like the query" (as opposed to "the prediction nearest to
// me") should use this instead of predictions[0]. Scores every candidate by
// how closely its name matches the query text (a sliding window the length
// of the query, minimum edit distance over all positions — so a candidate
// with extra trailing text, e.g. a category suffix, isn't unfairly
// penalized for length) and returns the best match, only if it clears a
// minimum similarity bar. Returns null (not a bad guess) when nothing
// clears that bar, e.g. a query that only matches something on
// proximity grounds.
const MIN_MATCH_RATIO = 0.4;

export function bestPlaceMatch(query: string, suggestions: PlaceSuggestion[]): PlaceSuggestion | null {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return null;

  let best: { suggestion: PlaceSuggestion; ratio: number } | null = null;
  for (const s of suggestions) {
    const candidate = normalize(s.name);
    if (!candidate) continue;

    let distance: number;
    if (candidate.length <= normalizedQuery.length) {
      distance = levenshtein(normalizedQuery, candidate);
    } else {
      distance = Infinity;
      for (let i = 0; i <= candidate.length - normalizedQuery.length; i++) {
        distance = Math.min(distance, levenshtein(normalizedQuery, candidate.slice(i, i + normalizedQuery.length)));
      }
    }
    const ratio = 1 - distance / normalizedQuery.length;
    if (!best || ratio > best.ratio) best = { suggestion: s, ratio };
  }

  return best && best.ratio >= MIN_MATCH_RATIO ? best.suggestion : null;
}
