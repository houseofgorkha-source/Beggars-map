import { TransformRequestManager } from '@maplibre/maplibre-react-native';
import { rankPlaces, type RankablePlace } from './placeRanking';
import { isQueryTooShort, cacheKey, SearchCache } from './searchCache';

export { bestPlaceMatch, placeTypeRank, TYPE_RANK_POI } from './placeRanking';

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

export type PlaceSuggestion = RankablePlace & {
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  // OLA's own classification for this prediction. Kept because it's the only
  // signal separating a real restaurant from a street-address geocoder
  // artifact carrying the identical display name — see placeRanking.ts.
  types: string[];
};

// Mirrors web/src/lib/olaPlaces.ts's identical mitigation (remediation
// follow-up, 2026-09-04): mobile's searchPlaces() had no minimum length and
// no cache at all, unlike web's — every debounced keystroke from both
// MapScreen and PickLocationScreen fired its own OLA autocomplete request.
// The cache/gating logic itself lives in searchCache.ts (pure, unit-tested);
// kept as a per-platform duplicate of web's version rather than shared code,
// matching this app's existing convention for small pieces of logic that
// live on both platforms (see AGENTS.md's content-moderation/placeRanking
// precedent).
const placeCache = new SearchCache<PlaceSuggestion[]>();

export async function searchPlaces(query: string, near?: MapPoint): Promise<PlaceSuggestion[]> {
  if (!apiKey || isQueryTooShort(query)) return [];

  const key = cacheKey(query, near);
  const cached = placeCache.get(key);
  if (cached) return cached;

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
      types: Array.isArray(p.types) ? (p.types as string[]) : [],
    }))
    .filter((p) => typeof p.latitude === 'number' && typeof p.longitude === 'number');

  const ranked = rankPlaces(query, results);
  placeCache.set(key, ranked);

  return ranked;
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
