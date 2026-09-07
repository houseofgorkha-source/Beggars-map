// Covers web/src/lib/extractDimensions.ts — the pure, keyword-based
// extraction of cuisine/meal-type/dish/locality/price-range dimensions from
// a listing. This is the SINGLE source of truth for dimension extraction —
// both App.tsx's query-param filtering and the SEO sitemap generator
// (tools/build/generate-sitemap.mjs) import this exact file directly (via
// Node's native TS type-stripping, the same mechanism this test file
// itself relies on); there is no separate duplicated copy anywhere.
//
// Web-only: this is a web-specific SEO feature (query-param landing pages),
// not a shared cross-platform module like dishes.ts/placeRanking.ts, so
// there is no mobile copy to test against here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCuisines,
  extractMealTypes,
  extractDishNames,
  extractLocality,
  getPriceRanges,
  matchesPriceRange,
  PRICE_BANDS,
  buildDimensionIndex,
  filterByDimension,
  extractListingTags,
  denormalizeDimensionValue,
} from '../web/src/lib/extractDimensions.ts';

function makeListing(overrides = {}) {
  return {
    id: 'test-id',
    created_by: 'test-user',
    name: 'Test Restaurant',
    note: null,
    price_rupees: 60,
    photo_url: null,
    latitude: 12.9716,
    longitude: 77.5946,
    city: 'Bengaluru',
    created_at: '2026-01-01T00:00:00Z',
    location_label: null,
    dishes: null,
    rating: null,
    ...overrides,
  };
}

describe('extractCuisines', () => {
  test('matches cuisine keywords in the listing name', () => {
    const listing = makeListing({ name: 'Punjabi Dhaba' });
    assert.deepEqual(extractCuisines(listing), ['north-indian']);
  });

  test('matches cuisine keywords in the note', () => {
    const listing = makeListing({ note: 'Best dosa and idli in town' });
    assert.deepEqual(extractCuisines(listing), ['south-indian']);
  });

  test('matches cuisine keywords inside structured dish names', () => {
    const listing = makeListing({ dishes: [{ dish: 'Chole Bhature', price: 50 }] });
    const cuisines = extractCuisines(listing);
    assert.ok(cuisines.includes('north-indian'));
    assert.ok(cuisines.includes('chole-bhature'));
  });

  test('a listing can match multiple cuisines', () => {
    const listing = makeListing({ name: 'South Indian Biryani House', note: 'chinese also available' });
    const cuisines = extractCuisines(listing);
    assert.ok(cuisines.includes('south-indian'));
    assert.ok(cuisines.includes('biryani'));
    assert.ok(cuisines.includes('chinese'));
  });

  test('returns empty array when nothing matches', () => {
    const listing = makeListing({ name: 'XYZ Foods', note: null, dishes: null });
    assert.deepEqual(extractCuisines(listing), []);
  });

  test('never fabricates a cuisine not present in text or dishes', () => {
    const listing = makeListing({ name: 'Random Snacks Corner' });
    assert.deepEqual(extractCuisines(listing), []);
  });

  // Bare single-word 'north'/'south' keywords were removed (2026-09-07
  // audit finding) — they're common English words with everyday non-cuisine
  // usage (a gate, an entrance, a direction) and had no word-boundary check
  // beyond plain substring matching, so they were a structural
  // false-positive risk even though no false positive existed in production
  // data at the time. These tests guard against reintroducing them.
  test('does not tag a listing as a cuisine from an unrelated directional/geographic word', () => {
    const northGate = makeListing({ note: 'Enter from the north gate, parking available' });
    assert.deepEqual(extractCuisines(northGate), []);

    const southFacing = makeListing({ note: 'South-facing entrance, wheelchair accessible' });
    assert.deepEqual(extractCuisines(southFacing), []);

    const southOfRoad = makeListing({ note: 'Located just south of MG Road' });
    assert.deepEqual(extractCuisines(southOfRoad), []);
  });

  test('still matches the specific compound phrases "north indian"/"south indian"', () => {
    assert.deepEqual(extractCuisines(makeListing({ note: 'Pure north indian thali' })), ['north-indian']);
    assert.deepEqual(extractCuisines(makeListing({ note: 'Authentic south indian breakfast' })), ['south-indian']);
  });
});

describe('extractMealTypes', () => {
  test('matches breakfast keywords', () => {
    const listing = makeListing({ dishes: [{ dish: 'Idli Vada', price: 40 }] });
    assert.deepEqual(extractMealTypes(listing), ['breakfast']);
  });

  test('matches thali/combo keywords', () => {
    const listing = makeListing({ name: 'Meals Thali Corner' });
    const mealTypes = extractMealTypes(listing);
    assert.ok(mealTypes.includes('thali'));
  });

  test('returns empty when no meal-type keyword present', () => {
    const listing = makeListing({ name: 'ABC Restaurant', note: null });
    assert.deepEqual(extractMealTypes(listing), []);
  });
});

describe('extractDishNames', () => {
  test('extracts and normalizes dish names from structured dishes', () => {
    const listing = makeListing({
      dishes: [
        { dish: 'Masala Dosa', price: 60 },
        { dish: 'Idli Vada', price: 40 },
      ],
    });
    assert.deepEqual(extractDishNames(listing), ['idli vada', 'masala dosa']);
  });

  test('dedupes identical dish names', () => {
    const listing = makeListing({
      dishes: [
        { dish: 'Dosa', price: 50 },
        { dish: 'dosa', price: 55 },
      ],
    });
    assert.deepEqual(extractDishNames(listing), ['dosa']);
  });

  test('returns empty array for listings with no dishes (pre-0020 rows)', () => {
    const listing = makeListing({ dishes: null });
    assert.deepEqual(extractDishNames(listing), []);
  });
});

describe('extractLocality', () => {
  test('extracts the last comma-separated segment as the locality', () => {
    const listing = makeListing({ location_label: '7th Main Road, Indiranagar' });
    assert.equal(extractLocality(listing), 'indiranagar');
  });

  test('returns the sole segment when there is no comma', () => {
    const listing = makeListing({ location_label: 'Malleswaram' });
    assert.equal(extractLocality(listing), 'malleswaram');
  });

  test('returns null when location_label is null (never fabricated)', () => {
    const listing = makeListing({ location_label: null });
    assert.equal(extractLocality(listing), null);
  });

  test('skips trailing empty segments from a trailing comma', () => {
    const listing = makeListing({ location_label: 'Koramangala, ' });
    assert.equal(extractLocality(listing), 'koramangala');
  });
});

// Cumulative price semantics (2026-09-07 fix): 'under-50' means <=₹50,
// 'under-75' means <=₹75, 'under-100' means <=₹100 — each is a ceiling, not
// a mutually-exclusive slice. A single listing can and should belong to
// multiple bands at once, consistent with Beggars Map's "₹100 or less"
// positioning (a ₹40 listing genuinely IS "under 100", not just "under 50").
describe('getPriceRanges (cumulative)', () => {
  test('a ₹40 listing belongs to all three bands', () => {
    assert.deepEqual(getPriceRanges(makeListing({ price_rupees: 40 })), ['under-50', 'under-75', 'under-100']);
  });

  test('a ₹60 listing belongs to under-75 and under-100, not under-50', () => {
    assert.deepEqual(getPriceRanges(makeListing({ price_rupees: 60 })), ['under-75', 'under-100']);
  });

  test('a ₹90 listing belongs only to under-100', () => {
    assert.deepEqual(getPriceRanges(makeListing({ price_rupees: 90 })), ['under-100']);
  });

  test('boundary values are inclusive (<=, not <)', () => {
    assert.deepEqual(getPriceRanges(makeListing({ price_rupees: 50 })), ['under-50', 'under-75', 'under-100']);
    assert.deepEqual(getPriceRanges(makeListing({ price_rupees: 75 })), ['under-75', 'under-100']);
    assert.deepEqual(getPriceRanges(makeListing({ price_rupees: 100 })), ['under-100']);
  });

  test('PRICE_BANDS is exactly the three cumulative bands, in ascending order', () => {
    assert.deepEqual(PRICE_BANDS, ['under-50', 'under-75', 'under-100']);
  });
});

describe('matchesPriceRange (cumulative)', () => {
  test('a ₹40 listing matches every band', () => {
    const listing = makeListing({ price_rupees: 40 });
    assert.equal(matchesPriceRange(listing, 'under-50'), true);
    assert.equal(matchesPriceRange(listing, 'under-75'), true);
    assert.equal(matchesPriceRange(listing, 'under-100'), true);
  });

  test('a ₹90 listing matches only under-100', () => {
    const listing = makeListing({ price_rupees: 90 });
    assert.equal(matchesPriceRange(listing, 'under-50'), false);
    assert.equal(matchesPriceRange(listing, 'under-75'), false);
    assert.equal(matchesPriceRange(listing, 'under-100'), true);
  });

  test('an unknown band value never matches (never guesses)', () => {
    const listing = makeListing({ price_rupees: 30 });
    assert.equal(matchesPriceRange(listing, 'under-9999'), false);
  });
});

describe('buildDimensionIndex', () => {
  test('counts each dimension across multiple listings', () => {
    const listings = [
      makeListing({ name: 'North Indian Dhaba', location_label: 'MG Road, Indiranagar' }),
      makeListing({ name: 'Another Punjabi Place', location_label: 'CMH Road, Indiranagar' }),
      makeListing({ name: 'South Indian Mess', location_label: 'Koramangala' }),
    ];
    const index = buildDimensionIndex(listings);
    assert.equal(index.cuisines['north-indian'], 2);
    assert.equal(index.cuisines['south-indian'], 1);
    assert.equal(index.localities['indiranagar'], 2);
    assert.equal(index.localities['koramangala'], 1);
  });

  test('empty listing set produces empty indexes, not errors', () => {
    const index = buildDimensionIndex([]);
    assert.deepEqual(index.cuisines, {});
    assert.deepEqual(index.localities, {});
  });

  test('price counting is cumulative — a cheap listing increments every band it qualifies for', () => {
    const listings = [
      makeListing({ price_rupees: 40 }), // under-50, under-75, under-100
      makeListing({ price_rupees: 90 }), // under-100 only
    ];
    const index = buildDimensionIndex(listings);
    assert.equal(index.priceRanges['under-50'], 1);
    assert.equal(index.priceRanges['under-75'], 1);
    assert.equal(index.priceRanges['under-100'], 2);
  });
});

describe('filterByDimension', () => {
  test('filters listings by cuisine and preserves extra fields on the input type', () => {
    const listings = [
      makeListing({ id: 'a', name: 'Punjabi Dhaba', voteCount: 5 }),
      makeListing({ id: 'b', name: 'South Indian Mess' }),
    ];
    const filtered = filterByDimension(listings, 'cuisine', 'north-indian');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'a');
    // voteCount (a field not known to Listing) survives the generic filter —
    // proves filterByDimension<T> preserves the caller's actual type rather
    // than narrowing back to the base Listing shape.
    assert.equal(filtered[0].voteCount, 5);
  });

  test('filters listings by locality (exact match, case-insensitive)', () => {
    const listings = [
      makeListing({ id: 'a', location_label: 'Koramangala' }),
      makeListing({ id: 'b', location_label: 'Indiranagar' }),
    ];
    const filtered = filterByDimension(listings, 'locality', 'Koramangala');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'a');
  });

  test('filters listings by price-range (cumulative — a cheap listing matches every wider band too)', () => {
    const listings = [
      makeListing({ id: 'a', price_rupees: 40 }),
      makeListing({ id: 'b', price_rupees: 90 }),
    ];
    // under-50 only catches the ₹40 listing.
    assert.deepEqual(filterByDimension(listings, 'price-range', 'under-50').map((l) => l.id), ['a']);
    // under-100 catches BOTH — this is the fix: previously 'under-100' was
    // a mutually-exclusive 76-100 slice and would have excluded the ₹40 one.
    assert.deepEqual(
      filterByDimension(listings, 'price-range', 'under-100').map((l) => l.id).sort(),
      ['a', 'b']
    );
  });

  test('returns empty array when nothing matches (never guesses)', () => {
    const listings = [makeListing({ name: 'Random Corner' })];
    const filtered = filterByDimension(listings, 'cuisine', 'bengali');
    assert.deepEqual(filtered, []);
  });
});

describe('extractListingTags', () => {
  test('builds a uniform per-dimension tag-array shape, including cumulative price', () => {
    const listing = makeListing({
      name: 'Punjabi Dhaba',
      note: 'lunch thali',
      price_rupees: 40,
      location_label: 'MG Road, Indiranagar',
      dishes: [{ dish: 'Chole Bhature', price: 40 }],
    });
    const tags = extractListingTags(listing);
    assert.deepEqual(tags.cuisine.sort(), ['chole-bhature', 'north-indian']);
    assert.ok(tags.mealType.includes('lunch'));
    assert.ok(tags.mealType.includes('thali'));
    assert.deepEqual(tags.dish, ['chole bhature']);
    assert.deepEqual(tags.locality, ['indiranagar']);
    assert.deepEqual(tags.price, ['under-50', 'under-75', 'under-100']);
  });

  test('locality is an empty array, not null, when location_label is absent', () => {
    const tags = extractListingTags(makeListing({ location_label: null }));
    assert.deepEqual(tags.locality, []);
  });
});

describe('denormalizeDimensionValue', () => {
  test('converts a dash-separated slug to a capitalized display string', () => {
    assert.equal(denormalizeDimensionValue('north-indian'), 'North Indian');
    assert.equal(denormalizeDimensionValue('under-50'), 'Under 50');
    assert.equal(denormalizeDimensionValue('koramangala'), 'Koramangala');
  });
});
