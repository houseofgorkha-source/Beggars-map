// Pure, dependency-free cache logic for OLA place-search results — split
// out so it can be unit tested under plain Node. olaMaps.ts's searchPlaces()
// imports @maplibre/maplibre-react-native at module load, which can't be
// resolved outside Expo/Metro, so it can't be imported by tests/*.test.mjs
// directly — same reasoning that split extractGoogleCoords.ts out of
// googleMapsLink.ts. Mirrors web/src/lib/olaPlaces.ts's identical inline
// logic (same constants, same eviction rule), kept as a separate per-platform
// module rather than shared code per this app's existing convention for
// small duplicated pieces of logic (content moderation, placeRanking).

export const MIN_QUERY_LENGTH = 3;
export const CACHE_TTL_MS = 5 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 200;

export type NearPoint = { latitude: number; longitude: number };

export function isQueryTooShort(query: string): boolean {
  return query.trim().length < MIN_QUERY_LENGTH;
}

// Normalized query text + a coarse (~1km, 2-decimal) rounding of the bias
// point — exact floating-point coordinates would fragment the cache for no
// real benefit, since `near` only actually changes a handful of times per
// session in practice.
export function cacheKey(query: string, near?: NearPoint): string {
  const normalized = query.trim().toLowerCase();
  const nearKey = near ? `${near.latitude.toFixed(2)},${near.longitude.toFixed(2)}` : 'none';
  return `${normalized}|${nearKey}`;
}

export class SearchCache<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();
  private ttlMs: number;
  private maxEntries: number;

  // Plain field assignments, not TS constructor-parameter-property shorthand
  // — Node's native type-stripping (used by `npm test`, no transpile step)
  // only supports erasable syntax and rejects that shorthand outright.
  constructor(ttlMs: number = CACHE_TTL_MS, maxEntries: number = CACHE_MAX_ENTRIES) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string, now: number = Date.now()): T | undefined {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= now) return undefined;
    return entry.value;
  }

  set(key: string, value: T, now: number = Date.now()): void {
    // Evict the oldest entry (Map preserves insertion order) rather than
    // growing unbounded — a plain LRU would be more precise but is more
    // machinery than this client-side convenience cache warrants.
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
  }

  get size(): number {
    return this.store.size;
  }
}
