// Place/landmark search only — OLA Places autocomplete. Map rendering is
// Google Maps JS API (see googleMaps.ts); this file has no rendering
// responsibility, unlike the pre-migration olaMaps.ts it's revived from
// (that also had vectorStyleUrl/transformRequest/staticMapUrl for MapLibre
// tiles, none of which apply now).
//
// The ranking/selection logic lives in placeRanking.ts (pure, unit-tested).
// `bestPlaceMatch` is re-exported here so existing callers keep importing it
// from this module.
import { bestPlaceMatch, type RankablePlace } from './placeRanking';

export { bestPlaceMatch };

const OLA_BASE = 'https://api.olamaps.io';
const apiKey = import.meta.env.VITE_OLA_MAPS_API_KEY as string | undefined;

export type PlaceSuggestion = RankablePlace & {
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  // OLA's own classification for this prediction. Kept because it's the only
  // signal that separates a real restaurant from a street-address geocoder
  // artifact carrying the identical display name — see placeRanking.ts for the
  // confirmed "Juicy Spot" case this exists to fix.
  types: string[];
};

// Remediation plan P6-3 (I-2): every debounced keystroke and every executed
// search previously fired its own OLA autocomplete request with no cache and
// no minimum length — on the free tier this is the app's largest single
// external-cost exposure, and it's also unrestricted client-side (see the
// CTO audit's C-3 finding on the key itself). Two independent, cheap
// mitigations, neither requiring a new architecture:
//
// 1. A query under MIN_QUERY_LENGTH never reaches the network at all — a
//    1-2 character query is rarely a useful area/landmark search anyway,
//    and it's the case a fast typist generates the most requests for.
// 2. An in-memory cache, keyed on the normalized query text plus a coarse
//    (~1km) rounding of the bias point. Coarse rounding, not exact
//    coordinates: `near` only actually changes once per session in
//    practice (BENGALURU_CENTER until geolocation resolves, then the
//    user's real position for the rest of the tab's life — see App.tsx),
//    so keying on exact floating-point coordinates would fragment the
//    cache for no real benefit; rounding to 2 decimal places keeps repeat
//    searches (a user re-typing a query, or the debounce re-firing for an
//    unrelated re-render) as cache hits without conflating genuinely
//    different areas. TTL-bounded (OLA's own data can change) and
//    size-bounded (a long-lived tab shouldn't accumulate unbounded
//    entries) — both deliberately generous rather than tuned, since this
//    is a client-side convenience cache, not a correctness boundary.
const MIN_QUERY_LENGTH = 3;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

type CacheEntry = { results: PlaceSuggestion[]; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(query: string, near?: { latitude: number; longitude: number }) {
  const normalized = query.trim().toLowerCase();
  const nearKey = near ? `${near.latitude.toFixed(2)},${near.longitude.toFixed(2)}` : 'none';
  return `${normalized}|${nearKey}`;
}

export async function searchPlaces(query: string, near?: { latitude: number; longitude: number }): Promise<PlaceSuggestion[]> {
  if (!apiKey || query.trim().length < MIN_QUERY_LENGTH) return [];

  const key = cacheKey(query, near);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.results;

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

  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Evict the oldest entry (Map preserves insertion order) rather than
    // growing unbounded — a plain LRU would be more precise but is more
    // machinery than a client-side convenience cache warrants here.
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });

  return results;
}
