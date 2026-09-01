import { TransformRequestManager } from '@maplibre/maplibre-react-native';

const OLA_BASE = 'https://api.olamaps.io';

// The OLA style JSON references tile/sprite/glyph URLs that don't carry the
// api_key themselves — MapLibre needs to append it to every request to OLA.
const apiKey = process.env.EXPO_PUBLIC_OLA_MAPS_API_KEY;
if (apiKey) {
  TransformRequestManager.addUrlSearchParam({
    id: 'ola-maps-api-key',
    match: /api\.olamaps\.io/,
    name: 'api_key',
    value: apiKey,
  });
}

type MapPoint = { latitude: number; longitude: number };

export function vectorStyleUrl(style: 'default-light-standard' | 'default-dark-standard' = 'default-light-standard') {
  const apiKey = process.env.EXPO_PUBLIC_OLA_MAPS_API_KEY;
  if (!apiKey) return null;
  return `${OLA_BASE}/tiles/vector/v1/styles/${style}/style.json?api_key=${apiKey}`;
}

export function staticMapUrl(points: MapPoint[], width: number, height: number): string | null {
  const apiKey = process.env.EXPO_PUBLIC_OLA_MAPS_API_KEY;
  if (!apiKey || points.length === 0) return null;

  const pad = 0.01;
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const minLat = Math.min(...lats) - pad;
  const maxLat = Math.max(...lats) + pad;
  const minLng = Math.min(...lngs) - pad;
  const maxLng = Math.max(...lngs) + pad;

  const markers = points
    .map((p) => `marker=${p.longitude},${p.latitude}|red`)
    .join('&');

  return `${OLA_BASE}/tiles/v1/styles/default-light-standard/static/${minLng},${minLat},${maxLng},${maxLat}/${width}x${height}.png?api_key=${apiKey}&${markers}`;
}

export type PlaceSuggestion = {
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
};

function normalizePlaceText(s: string): string {
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

// OLA's autocomplete ranks predictions mostly by proximity to the bias
// point, not by name relevance — confirmed on web (searching "Juicy Spot"
// biased near Bengaluru center returned an unrelated street address as
// prediction #1, with the actual restaurant only at #2). Same endpoint,
// same behavior here, so re-rank by how closely each result's name matches
// the typed query (sliding-window edit distance, so a longer name with a
// trailing category suffix isn't unfairly penalized for length) and float
// the best name match to the top. Results that don't clear a minimum
// similarity bar keep OLA's own relative order at the end, rather than
// forcing a guess on a genuinely ambiguous query.
const MIN_NAME_MATCH_RATIO = 0.4;

function nameMatchRatio(query: string, name: string): number {
  const normalizedQuery = normalizePlaceText(query);
  const candidate = normalizePlaceText(name);
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

function rankByNameMatch(query: string, results: PlaceSuggestion[]): PlaceSuggestion[] {
  return results
    .map((result, index) => ({ result, index, ratio: nameMatchRatio(query, result.name) }))
    .sort((a, b) => {
      const aGood = a.ratio >= MIN_NAME_MATCH_RATIO;
      const bGood = b.ratio >= MIN_NAME_MATCH_RATIO;
      if (aGood !== bGood) return aGood ? -1 : 1;
      if (aGood) return b.ratio - a.ratio || a.index - b.index;
      return a.index - b.index; // neither clears the bar — keep OLA's own order
    })
    .map((scored) => scored.result);
}

export async function searchPlaces(query: string, near?: MapPoint): Promise<PlaceSuggestion[]> {
  if (!apiKey || !query.trim()) return [];

  const params = new URLSearchParams({ input: query, api_key: apiKey });
  if (near) params.set('location', `${near.latitude},${near.longitude}`);

  const response = await fetch(`${OLA_BASE}/places/v1/autocomplete?${params.toString()}`);
  if (!response.ok) return [];

  const data = await response.json();
  const predictions: any[] = data.predictions ?? [];

  const results = predictions
    .map((p) => ({
      placeId: p.place_id as string,
      name: (p.structured_formatting?.main_text ?? p.description ?? '') as string,
      address: (p.structured_formatting?.secondary_text ?? '') as string,
      latitude: p.geometry?.location?.lat as number,
      longitude: p.geometry?.location?.lng as number,
    }))
    .filter((p) => typeof p.latitude === 'number' && typeof p.longitude === 'number');

  return rankByNameMatch(query, results);
}

export function boundsForPoints(points: MapPoint[]): [number, number, number, number] | null {
  if (points.length === 0) return null;
  const pad = 0.01;
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  return [
    Math.min(...lngs) - pad,
    Math.min(...lats) - pad,
    Math.max(...lngs) + pad,
    Math.max(...lats) + pad,
  ];
}
