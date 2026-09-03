// Covers src/lib/searchCache.ts — the pure cache/gating logic extracted
// from mobile's searchPlaces() (src/lib/olaMaps.ts) so it can be unit
// tested under plain Node. olaMaps.ts itself imports
// @maplibre/maplibre-react-native at module load and can't be resolved
// outside Expo/Metro, so it isn't imported directly here — same reasoning
// as googleMapsLink.ts/extractGoogleCoords.ts.
//
// This is the mobile-side fix for the OLA autocomplete cost exposure
// identified in the OLA credential audit: mobile's searchPlaces() had no
// minimum query length and no cache at all (unlike web's
// web/src/lib/olaPlaces.ts, which already had this same mitigation from an
// earlier remediation pass).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_QUERY_LENGTH, CACHE_TTL_MS, CACHE_MAX_ENTRIES, isQueryTooShort, cacheKey, SearchCache } from '../src/lib/searchCache.ts';

describe('isQueryTooShort', () => {
  test('rejects empty and whitespace-only queries', () => {
    assert.equal(isQueryTooShort(''), true);
    assert.equal(isQueryTooShort('   '), true);
  });

  test('rejects queries under the 3-character minimum', () => {
    assert.equal(isQueryTooShort('a'), true);
    assert.equal(isQueryTooShort('ab'), true);
  });

  test('accepts queries at or above the minimum', () => {
    assert.equal(isQueryTooShort('abc'), false);
    assert.equal(isQueryTooShort('dosa'), false);
  });

  test('trims before measuring length', () => {
    assert.equal(isQueryTooShort('  ab  '), true);
    assert.equal(isQueryTooShort('  abc  '), false);
  });

  test('the exported constant is 3', () => {
    assert.equal(MIN_QUERY_LENGTH, 3);
  });
});

describe('cacheKey', () => {
  test('normalizes case and trims whitespace', () => {
    assert.equal(cacheKey('Dosa'), cacheKey('  dosa  '));
  });

  test('a query with no bias point gets a stable "none" key', () => {
    assert.equal(cacheKey('dosa'), 'dosa|none');
  });

  test('rounds the bias point coarsely (~1km, 2 decimals)', () => {
    const a = cacheKey('dosa', { latitude: 12.9716, longitude: 77.5946 });
    const b = cacheKey('dosa', { latitude: 12.9719, longitude: 77.5944 });
    assert.equal(a, b, 'nearby points within the same 2-decimal cell must collapse to the same key');
  });

  test('genuinely different areas produce different keys', () => {
    const koramangala = cacheKey('dosa', { latitude: 12.9352, longitude: 77.6146 });
    const malleswaram = cacheKey('dosa', { latitude: 13.0027, longitude: 77.5645 });
    assert.notEqual(koramangala, malleswaram);
  });

  test('different query text always produces a different key at the same point', () => {
    const near = { latitude: 12.97, longitude: 77.59 };
    assert.notEqual(cacheKey('dosa', near), cacheKey('idli', near));
  });
});

describe('SearchCache', () => {
  test('a miss returns undefined', () => {
    const cache = new SearchCache();
    assert.equal(cache.get('nope'), undefined);
  });

  test('a hit returns the stored value', () => {
    const cache = new SearchCache();
    cache.set('dosa|none', ['result-a']);
    assert.deepEqual(cache.get('dosa|none'), ['result-a']);
  });

  test('an entry expires after its TTL', () => {
    const cache = new SearchCache(1000);
    const start = 1_000_000;
    cache.set('dosa|none', ['result-a'], start);
    assert.deepEqual(cache.get('dosa|none', start + 500), ['result-a'], 'still fresh before the TTL elapses');
    assert.equal(cache.get('dosa|none', start + 1000), undefined, 'expired once the TTL has elapsed');
  });

  test('the default TTL matches the exported constant (5 minutes)', () => {
    assert.equal(CACHE_TTL_MS, 5 * 60 * 1000);
    const cache = new SearchCache();
    const start = 1_000_000;
    cache.set('dosa|none', ['result-a'], start);
    assert.deepEqual(cache.get('dosa|none', start + CACHE_TTL_MS - 1), ['result-a']);
    assert.equal(cache.get('dosa|none', start + CACHE_TTL_MS), undefined);
  });

  test('the cache is bounded — the oldest entry is evicted once maxEntries is reached', () => {
    const cache = new SearchCache(CACHE_TTL_MS, 3);
    cache.set('a', ['1']);
    cache.set('b', ['2']);
    cache.set('c', ['3']);
    assert.equal(cache.size, 3);
    cache.set('d', ['4']);
    assert.equal(cache.size, 3, 'size must never exceed maxEntries');
    assert.equal(cache.get('a'), undefined, 'the oldest entry (a) must have been evicted');
    assert.deepEqual(cache.get('d'), ['4'], 'the newest entry must be present');
  });

  test('the default bound matches the exported constant (200 entries)', () => {
    assert.equal(CACHE_MAX_ENTRIES, 200);
  });

  test('re-setting an existing key does not count as a new entry toward the bound', () => {
    const cache = new SearchCache(CACHE_TTL_MS, 2);
    cache.set('a', ['1']);
    cache.set('b', ['2']);
    cache.set('a', ['1-updated']);
    assert.equal(cache.size, 2, 'updating an existing key must not evict anything or grow past the bound');
    assert.deepEqual(cache.get('a'), ['1-updated']);
    assert.deepEqual(cache.get('b'), ['2'], 'b must not have been evicted by re-setting a');
  });
});
