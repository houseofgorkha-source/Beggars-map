// Ranking/selection tests for OLA place predictions.
//
// Run with:  npm test        (node --test, no dependencies — Node strips the
//                             TypeScript types natively)
//
// The web app and the mobile app each keep their own copy of placeRanking.ts
// (see the header comment in either file for why). Every test here runs against
// BOTH copies, so the two can't silently drift apart.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as web from '../web/src/lib/placeRanking.ts';
import * as mobile from '../src/lib/placeRanking.ts';
import * as edge from '../supabase/functions/_shared/placeRanking.ts';

const IMPLS = [
  ['web', web],
  ['mobile', mobile],
  ['edge', edge],
];

// ---------------------------------------------------------------------------
// The real, measured "Juicy Spot" response.
//
// Captured live from api.olamaps.io/places/v1/autocomplete on 2026-09-03 with
// location=12.9716,77.5946 (the same Bengaluru-center bias the app uses when
// the viewer's location is unknown). All four predictions display the IDENTICAL
// name, so name similarity alone cannot separate them. Distances from the real
// restaurant (#2): #1 is 1,080 m, #3 is 2,727 m, #4 is 7,834 m.
// ---------------------------------------------------------------------------
const JUICY_SPOT_PREDICTIONS = [
  { name: 'Juicy SPOT', types: ['street_address'], latitude: 12.953836, longitude: 77.623053 },
  { name: 'Juicy SPOT', types: ['food', 'restaurant'], latitude: 12.9459, longitude: 77.6288 },
  { name: 'Juicy SPOT', types: ['street_address'], latitude: 12.924427, longitude: 77.616647 },
  { name: 'Juicy SPOT', types: ['street_address'], latitude: 12.880821, longitude: 77.601109 },
];

// The real "Dhal Roti and More" response, same capture. Here the names DIFFER,
// so name matching alone already picks correctly — this is the regression guard
// that type ranking hasn't disturbed it.
const DHAL_ROTI_PREDICTIONS = [
  { name: 'One More Roti Please - Kalyan Nagar', types: ['establishment'], latitude: 13.0287, longitude: 77.6349 },
  { name: 'Dal Roti And More (North Indian Restaurant)', types: ['establishment'], latitude: 12.9432, longitude: 77.6283 },
  { name: 'Modern Doll Salon', types: ['beauty_salon', 'hair_care'], latitude: 12.9202, longitude: 77.7414 },
  { name: 'Rotti Butti', types: ['establishment'], latitude: 12.9647, longitude: 77.5307 },
];

for (const [label, impl] of IMPLS) {
  describe(`placeRanking (${label})`, () => {
    const { bestPlaceMatch, rankPlaces, placeTypeRank, nameMatchRatio, TYPE_RANK_POI, TYPE_RANK_ADDRESS, TYPE_RANK_UNKNOWN } = impl;

    // -----------------------------------------------------------------
    // The reported bug
    // -----------------------------------------------------------------
    describe('the Juicy Spot case', () => {
      test('picks the restaurant, not the street address 1,080 m away', () => {
        const match = bestPlaceMatch('Juicy Spot', JUICY_SPOT_PREDICTIONS);
        assert.ok(match, 'expected a match');
        assert.deepEqual(match.types, ['food', 'restaurant']);
        assert.equal(match.latitude, 12.9459);
        assert.equal(match.longitude, 77.6288);
      });

      test('picks the restaurant regardless of where OLA orders it', () => {
        // OLA orders by proximity to the bias point, which varies with the
        // viewer's location — the restaurant must win from any position.
        for (let i = 0; i < JUICY_SPOT_PREDICTIONS.length; i++) {
          const rotated = [...JUICY_SPOT_PREDICTIONS.slice(i), ...JUICY_SPOT_PREDICTIONS.slice(0, i)];
          const match = bestPlaceMatch('Juicy Spot', rotated);
          assert.deepEqual(match.types, ['food', 'restaurant'], `failed with rotation ${i}`);
        }
      });

      test('rankPlaces floats the restaurant above the identically-named artifacts', () => {
        const ranked = rankPlaces('Juicy Spot', JUICY_SPOT_PREDICTIONS);
        assert.deepEqual(ranked[0].types, ['food', 'restaurant']);
      });

      test('before the fix this was the failure: array order alone chose #1', () => {
        // Documents precisely what regressed. With name-only scoring all four
        // ratios are equal, so the winner was whichever OLA returned first.
        const ratios = JUICY_SPOT_PREDICTIONS.map((p) => nameMatchRatio('Juicy Spot', p.name));
        assert.equal(new Set(ratios).size, 1, 'all four names score identically');
        assert.notDeepEqual(JUICY_SPOT_PREDICTIONS[0].types, ['food', 'restaurant']);
      });
    });

    // -----------------------------------------------------------------
    // Guard: never blindly prefer a POI
    // -----------------------------------------------------------------
    describe('does not blindly prefer a POI', () => {
      test('a clearly better name match wins even when it is an address', () => {
        const candidates = [
          { name: 'Some Unrelated Dhaba', types: ['food', 'restaurant'] },
          { name: 'Juicy Spot', types: ['street_address'] },
        ];
        const match = bestPlaceMatch('Juicy Spot', candidates);
        assert.equal(match.name, 'Juicy Spot');
        assert.deepEqual(match.types, ['street_address']);
      });

      test('an exact branch match beats a generic same-chain POI', () => {
        // The Rajanna case in miniature: several branches share a name, and the
        // query names one specifically. Type rank must not override that.
        const candidates = [
          { name: 'Rajanna Military Hotel', types: ['food', 'restaurant'] },
          { name: 'Rajanna Military Hotel Tatanagar', types: ['food', 'restaurant'] },
        ];
        const match = bestPlaceMatch('Rajanna Military Hotel Tatanagar', candidates);
        assert.equal(match.name, 'Rajanna Military Hotel Tatanagar');
      });

      test('a POI whose name does not clear the bar is never returned', () => {
        const candidates = [{ name: 'Completely Different Cafe', types: ['food', 'restaurant'] }];
        assert.equal(bestPlaceMatch('Juicy Spot', candidates), null);
      });

      test('returns null rather than guessing when nothing matches', () => {
        assert.equal(bestPlaceMatch('Juicy Spot', []), null);
        assert.equal(bestPlaceMatch('', JUICY_SPOT_PREDICTIONS), null);
      });
    });

    // -----------------------------------------------------------------
    // Regression: existing behaviour preserved
    // -----------------------------------------------------------------
    describe('existing behaviour is preserved', () => {
      test('Dhal Roti still resolves to the correct restaurant, not prediction #1', () => {
        const match = bestPlaceMatch('Dhal Roti and More', DHAL_ROTI_PREDICTIONS);
        assert.equal(match.name, 'Dal Roti And More (North Indian Restaurant)');
        assert.equal(match.latitude, 12.9432);
      });

      test('a trailing category suffix is not penalised for length', () => {
        const candidates = [
          { name: 'Meghana Foods Indiranagar Andhra Style Biryani Restaurant', types: ['food'] },
          { name: 'Something Else Entirely', types: ['food'] },
        ];
        const match = bestPlaceMatch('Meghana Foods', candidates);
        assert.ok(match.name.startsWith('Meghana Foods'));
      });

      test('rankPlaces keeps sub-threshold results in OLA’s own order at the end', () => {
        const ranked = rankPlaces('Juicy Spot', [
          { name: 'Zzz Unrelated One', types: ['food'] },
          { name: 'Juicy SPOT', types: ['food', 'restaurant'] },
          { name: 'Yyy Unrelated Two', types: ['food'] },
        ]);
        assert.equal(ranked[0].name, 'Juicy SPOT');
        assert.equal(ranked[1].name, 'Zzz Unrelated One');
        assert.equal(ranked[2].name, 'Yyy Unrelated Two');
      });

      test('ranking is stable — equal candidates keep their input order', () => {
        const candidates = [
          { name: 'Juicy SPOT', types: ['food', 'restaurant'], id: 'a' },
          { name: 'Juicy SPOT', types: ['food', 'restaurant'], id: 'b' },
        ];
        assert.equal(bestPlaceMatch('Juicy Spot', candidates).id, 'a');
      });
    });

    // -----------------------------------------------------------------
    // Type classification
    // -----------------------------------------------------------------
    describe('placeTypeRank', () => {
      test('classifies real POIs above address artifacts', () => {
        assert.equal(placeTypeRank(['food', 'restaurant']), TYPE_RANK_POI);
        assert.equal(placeTypeRank(['establishment']), TYPE_RANK_POI);
        assert.equal(placeTypeRank(['street_address']), TYPE_RANK_ADDRESS);
        assert.equal(placeTypeRank(['route', 'geocode']), TYPE_RANK_ADDRESS);
      });

      test('missing or unknown types degrade to neutral, never to artifact', () => {
        // Protects against a provider change silently ranking everything last.
        assert.equal(placeTypeRank(undefined), TYPE_RANK_UNKNOWN);
        assert.equal(placeTypeRank([]), TYPE_RANK_UNKNOWN);
        assert.equal(placeTypeRank(['some_future_type']), TYPE_RANK_UNKNOWN);
      });

      test('a POI type anywhere in the array wins over an address type', () => {
        assert.equal(placeTypeRank(['street_address', 'restaurant']), TYPE_RANK_POI);
      });

      test('untyped candidates still beat known artifacts on a name tie', () => {
        const match = bestPlaceMatch('Juicy Spot', [
          { name: 'Juicy SPOT', types: ['street_address'] },
          { name: 'Juicy SPOT' },
        ]);
        assert.equal(match.types, undefined);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Geographic sanity guard (web only) — the "Vigneshwara Tiffens" bug.
//
// Captured live from api.olamaps.io/places/v1/autocomplete, query
// "Vigneshwara Tiffens", biased at Bengaluru center (12.9716, 77.5946).
// Four of the five predictions are Hyderabad/Secunderabad restaurants of
// the same or a near-identical name; only #1 is the real Bengaluru place.
// Distances from the bias point: #0 498.7 km, #1 (real) 2.6 km, #2 508.8 km,
// #3 509.8 km, #4 502.8 km — measured with the exact same haversine formula
// the guard itself uses.
//
// This is deliberately a SEPARATE, web-only describe block, not another
// pass through IMPLS: mobile's and the edge function's own copies of
// placeRanking.ts were not touched, so they have no third `near` parameter
// and nothing here applies to them.
// ---------------------------------------------------------------------------
const BENGALURU_CENTER = { latitude: 12.9716, longitude: 77.5946 };

const VIGNESHWARA_PREDICTIONS = [
  { name: 'Vigneshwara Tiffins', types: ['restaurant'], latitude: 17.3624, longitude: 78.5396 }, // Hyderabad, 498.7 km
  { name: 'Sri Vigneshwara Tiffen', types: ['food', 'restaurant'], latitude: 12.972936, longitude: 77.570944 }, // Bengaluru, 2.6 km — the real match
  { name: "Vigneshwara Tiffin's", types: ['store'], latitude: 17.4648, longitude: 78.4924 }, // Secunderabad, 508.8 km
  { name: 'Vigneshwara Tiffins', types: ['restaurant'], latitude: 17.464743, longitude: 78.538658 }, // Hyderabad, 509.8 km
  { name: "Vigneshwara Tiffin's", types: ['restaurant'], latitude: 17.4095, longitude: 78.4908 }, // Hyderabad, 502.8 km
];

describe('geographic sanity guard (web only)', () => {
  const { bestPlaceMatch, filterByBiasDistance, MAX_BIAS_DISTANCE_KM } = web;

  describe('1. the Vigneshwara Tiffens case', () => {
    test('excludes the Hyderabad candidates and selects the real Bengaluru match', () => {
      const match = bestPlaceMatch('Vigneshwara Tiffens', VIGNESHWARA_PREDICTIONS, BENGALURU_CENTER);
      assert.ok(match, 'expected a match');
      assert.equal(match.name, 'Sri Vigneshwara Tiffen');
      assert.equal(match.latitude, 12.972936);
      assert.equal(match.longitude, 77.570944);
    });

    test('without the sanity guard, the higher name-ratio Hyderabad candidate would have won', () => {
      // Documents precisely what the bug was: with no `near` at all (the
      // pre-fix call shape), name ratio alone picks a Hyderabad restaurant.
      const unguarded = bestPlaceMatch('Vigneshwara Tiffens', VIGNESHWARA_PREDICTIONS);
      assert.equal(unguarded.name, 'Vigneshwara Tiffins');
      assert.notEqual(unguarded.latitude, 12.972936);
    });

    test('filterByBiasDistance alone drops exactly the four Hyderabad/Secunderabad entries', () => {
      const kept = filterByBiasDistance(VIGNESHWARA_PREDICTIONS, BENGALURU_CENTER);
      assert.equal(kept.length, 1);
      assert.equal(kept[0].name, 'Sri Vigneshwara Tiffen');
    });
  });

  describe('2. existing local ambiguity cases behave exactly as before', () => {
    test('Juicy Spot: the guard is a no-op when near is omitted (unchanged call shape)', () => {
      const match = bestPlaceMatch('Juicy Spot', JUICY_SPOT_PREDICTIONS);
      assert.deepEqual(match.types, ['food', 'restaurant']);
      assert.equal(match.latitude, 12.9459);
    });

    test('Dhal Roti: unchanged when near is omitted', () => {
      const match = bestPlaceMatch('Dhal Roti and More', DHAL_ROTI_PREDICTIONS);
      assert.equal(match.name, 'Dal Roti And More (North Indian Restaurant)');
    });
  });

  describe('3. candidates within the 50km boundary still get normal name/type ranking', () => {
    test('Juicy Spot case still resolves correctly WITH a near bias point supplied', () => {
      // All four Juicy Spot candidates are within ~8km of Bengaluru center —
      // comfortably inside MAX_BIAS_DISTANCE_KM — so supplying `near` here
      // must not change the outcome at all; the existing name/type ranking
      // (restaurant beats the three street-address artifacts) still decides.
      const match = bestPlaceMatch('Juicy Spot', JUICY_SPOT_PREDICTIONS, BENGALURU_CENTER);
      assert.deepEqual(match.types, ['food', 'restaurant']);
      assert.equal(match.latitude, 12.9459);
    });

    test('filterByBiasDistance keeps every candidate within the radius untouched', () => {
      const kept = filterByBiasDistance(JUICY_SPOT_PREDICTIONS, BENGALURU_CENTER);
      assert.equal(kept.length, JUICY_SPOT_PREDICTIONS.length);
      assert.deepEqual(kept, JUICY_SPOT_PREDICTIONS);
    });
  });

  describe('4. a far-outside candidate cannot win purely on name similarity', () => {
    test('a near-perfect name match 500km+ away loses to a real, in-range match', () => {
      const candidates = [
        { name: 'Exact Query Match', types: ['restaurant'], latitude: 17.3624, longitude: 78.5396 }, // Hyderabad, far
        { name: 'Exact Query Matc', types: ['restaurant'], latitude: 12.98, longitude: 77.6 }, // Bengaluru, close, one char short
      ];
      const match = bestPlaceMatch('Exact Query Match', candidates, BENGALURU_CENTER);
      assert.equal(match.name, 'Exact Query Matc');
    });

    test('a far candidate with no in-range alternative correctly returns null, not a bad guess', () => {
      const candidates = [{ name: 'Vigneshwara Tiffins', types: ['restaurant'], latitude: 17.3624, longitude: 78.5396 }];
      assert.equal(bestPlaceMatch('Vigneshwara Tiffens', candidates, BENGALURU_CENTER), null);
    });
  });

  describe('5. near absent/null preserves existing behaviour', () => {
    test('filterByBiasDistance with no near returns the identical array (no filtering)', () => {
      const kept = filterByBiasDistance(VIGNESHWARA_PREDICTIONS);
      assert.deepEqual(kept, VIGNESHWARA_PREDICTIONS);
    });

    test('filterByBiasDistance with near explicitly undefined is the same no-op', () => {
      const kept = filterByBiasDistance(VIGNESHWARA_PREDICTIONS, undefined);
      assert.deepEqual(kept, VIGNESHWARA_PREDICTIONS);
    });

    test('bestPlaceMatch called with the pre-existing 2-argument shape never throws', () => {
      assert.doesNotThrow(() => bestPlaceMatch('Vigneshwara Tiffens', VIGNESHWARA_PREDICTIONS));
    });

    test('a candidate missing coordinates is kept, never excluded, even when near is supplied', () => {
      const candidates = [{ name: 'No Coordinates Here', types: ['restaurant'] }];
      const kept = filterByBiasDistance(candidates, BENGALURU_CENTER);
      assert.equal(kept.length, 1);
    });

    test('MAX_BIAS_DISTANCE_KM is the documented 50km', () => {
      assert.equal(MAX_BIAS_DISTANCE_KM, 50);
    });
  });
});

// ---------------------------------------------------------------------------
// The Edge Function (resolve-maps-link) consumes RAW OLA predictions rather
// than the mapped PlaceSuggestion shape the apps use, so it gets its own pass
// over predictionsToPoints — the adapter where `types` is now preserved and
// where predictions missing coordinates or a name are dropped.
// ---------------------------------------------------------------------------
describe('resolve-maps-link prediction handling (edge)', () => {
  const { predictionsToPoints, bestPlaceMatch } = edge;

  // The same captured response, in OLA's raw wire shape.
  const RAW_JUICY_SPOT = [
    { structured_formatting: { main_text: 'Juicy SPOT' }, types: ['street_address'], geometry: { location: { lat: 12.953836, lng: 77.623053 } } },
    { structured_formatting: { main_text: 'Juicy SPOT' }, types: ['food', 'restaurant'], geometry: { location: { lat: 12.9459, lng: 77.6288 } } },
    { structured_formatting: { main_text: 'Juicy SPOT' }, types: ['street_address'], geometry: { location: { lat: 12.924427, lng: 77.616647 } } },
    { structured_formatting: { main_text: 'Juicy SPOT' }, types: ['street_address'], geometry: { location: { lat: 12.880821, lng: 77.601109 } } },
  ];

  /** Mirrors the Edge Function's own bestPlaceMatch wrapper exactly. */
  const resolve = (query, predictions) => {
    const match = bestPlaceMatch(query, predictionsToPoints(predictions));
    return match ? { lat: match.lat, lng: match.lng } : null;
  };

  test('preserves types off the raw prediction', () => {
    const points = predictionsToPoints(RAW_JUICY_SPOT);
    assert.equal(points.length, 4);
    assert.deepEqual(points[1].types, ['food', 'restaurant']);
    assert.deepEqual(points[0].types, ['street_address']);
  });

  test('resolves Juicy Spot to the restaurant, not the address 1,080 m away', () => {
    assert.deepEqual(resolve('Juicy Spot', RAW_JUICY_SPOT), { lat: 12.9459, lng: 77.6288 });
  });

  test('resolves correctly regardless of OLA’s proximity-driven ordering', () => {
    for (let i = 0; i < RAW_JUICY_SPOT.length; i++) {
      const rotated = [...RAW_JUICY_SPOT.slice(i), ...RAW_JUICY_SPOT.slice(0, i)];
      assert.deepEqual(resolve('Juicy Spot', rotated), { lat: 12.9459, lng: 77.6288 }, `rotation ${i}`);
    }
  });

  test('Rajanna: a distant same-chain POI does not beat the named branch', () => {
    // Both are genuine restaurants ~11 km apart, and the query names one
    // branch specifically. Type rank is equal, so name specificity must
    // decide — the generic branch must not win on being listed first.
    const raw = [
      { structured_formatting: { main_text: 'Rajanna Military Hotel' }, types: ['food', 'restaurant'], geometry: { location: { lat: 12.9662399, lng: 77.5351318 } } },
      { structured_formatting: { main_text: 'RAJANNA MILITARY HOTEL TATANAGAR' }, types: ['food', 'restaurant'], geometry: { location: { lat: 13.0562896, lng: 77.576662 } } },
    ];
    assert.deepEqual(resolve('Rajanna Military Hotel Tatanagar', raw), { lat: 13.0562896, lng: 77.576662 });
  });

  test('a street address still wins when its name matches clearly better', () => {
    const raw = [
      { structured_formatting: { main_text: 'Totally Different Restaurant' }, types: ['food', 'restaurant'], geometry: { location: { lat: 12.9, lng: 77.6 } } },
      { structured_formatting: { main_text: 'Juicy Spot' }, types: ['street_address'], geometry: { location: { lat: 12.95, lng: 77.62 } } },
    ];
    assert.deepEqual(resolve('Juicy Spot', raw), { lat: 12.95, lng: 77.62 });
  });

  test('drops predictions with no coordinates or no name', () => {
    const points = predictionsToPoints([
      { structured_formatting: { main_text: 'No Coords' }, types: ['food'] },
      { structured_formatting: { main_text: '' }, geometry: { location: { lat: 12.9, lng: 77.6 } } },
      { geometry: { location: { lat: 12.9, lng: 77.6 } }, description: 'From description' },
    ]);
    assert.equal(points.length, 1);
    assert.equal(points[0].name, 'From description');
  });

  test('falls back to description when structured_formatting is absent', () => {
    const points = predictionsToPoints([
      { description: 'Dal Roti And More', types: ['establishment'], geometry: { location: { lat: 12.9432, lng: 77.6283 } } },
    ]);
    assert.equal(points[0].name, 'Dal Roti And More');
  });

  test('missing types array becomes empty, never undefined', () => {
    const points = predictionsToPoints([
      { structured_formatting: { main_text: 'Untyped Place' }, geometry: { location: { lat: 12.9, lng: 77.6 } } },
    ]);
    assert.deepEqual(points[0].types, []);
  });

  test('returns null rather than guessing when nothing clears the bar', () => {
    assert.equal(resolve('Juicy Spot', []), null);
    assert.equal(resolve('Juicy Spot', [
      { structured_formatting: { main_text: 'Unrelated Place' }, types: ['food'], geometry: { location: { lat: 12.9, lng: 77.6 } } },
    ]), null);
  });
});
