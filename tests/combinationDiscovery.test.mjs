// Covers tools/build/combinationDiscovery.mjs — the pure multi-dimension
// combination discovery used by the SEO sitemap generator to find real
// cuisine × dish × mealType × price × locality intersections that at least
// 3 genuine listings simultaneously satisfy. Uses synthetic tagged-listing
// fixtures throughout (not live production data) so these tests are
// deterministic and require no network access — they prove the mechanism
// is correct, independent of what today's specific production snapshot
// happens to contain.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverCombinations,
  comboKey,
  listingMatchesCombo,
  DIMENSION_ORDER,
  DIMENSION_TO_PARAM,
} from '../tools/build/combinationDiscovery.mjs';

function tagged(tags) {
  return { tags: { cuisine: [], mealType: [], dish: [], locality: [], price: [], ...tags } };
}

describe('DIMENSION_ORDER', () => {
  test('never includes a near-me/nearby dimension', () => {
    // "near me" is a client-side geolocation feature (see AGENTS.md), never
    // a URL param — this guards against it ever being added to the
    // combination discoverer's dimension set, which would make it eligible
    // for sitemap inclusion.
    assert.ok(!DIMENSION_ORDER.some((d) => /near/i.test(d)));
  });
});

describe('DIMENSION_TO_PARAM', () => {
  test('never maps any dimension to a near-me/nearby query param', () => {
    // Belt-and-suspenders alongside the DIMENSION_ORDER check above: even
    // if a dimension name itself didn't mention "near", this catches a
    // dimension being mapped to a param NAME containing it (e.g. a future
    // 'locality' -> 'nearMe' remap).
    for (const paramName of Object.values(DIMENSION_TO_PARAM)) {
      assert.ok(!/near/i.test(paramName), `param "${paramName}" looks like a near-me param`);
    }
  });

  test('has an entry for every dimension in DIMENSION_ORDER', () => {
    for (const dim of DIMENSION_ORDER) {
      assert.ok(dim in DIMENSION_TO_PARAM, `missing param mapping for dimension "${dim}"`);
    }
  });
});

describe('discoverCombinations — threshold behavior', () => {
  test('exactly 2 matches is excluded', () => {
    const listings = [
      tagged({ cuisine: ['south-indian'], price: ['under-50'] }),
      tagged({ cuisine: ['south-indian'], price: ['under-50'] }),
    ];
    const results = discoverCombinations(listings, { minMatches: 3 });
    assert.equal(results.length, 0);
  });

  test('exactly 3 matches is included', () => {
    const listings = [
      tagged({ cuisine: ['south-indian'], price: ['under-50'] }),
      tagged({ cuisine: ['south-indian'], price: ['under-50'] }),
      tagged({ cuisine: ['south-indian'], price: ['under-50'] }),
    ];
    const results = discoverCombinations(listings, { minMatches: 3 });
    assert.equal(results.length, 1);
    assert.equal(results[0].count, 3);
    assert.equal(results[0].key, 'cuisine=south-indian&price=under-50');
  });

  test('4+ matches is included with the correct count', () => {
    const listings = Array.from({ length: 5 }, () => tagged({ cuisine: ['biryani'], mealType: ['lunch'] }));
    const results = discoverCombinations(listings, { minMatches: 3 });
    assert.equal(results.length, 1);
    assert.equal(results[0].count, 5);
  });

  test('zero-match intersection is excluded — two dimensions that never co-occur in any listing', () => {
    // Listing A has cuisine=south-indian but never mealType=dinner; listing
    // B has mealType=dinner but never cuisine=south-indian. No listing ever
    // embodies {cuisine=south-indian, mealType=dinner} together, so it must
    // never even be proposed as a candidate, let alone included.
    const listings = [
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'] }),
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'] }),
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'] }),
      tagged({ cuisine: ['north-indian'], mealType: ['dinner'] }),
      tagged({ cuisine: ['north-indian'], mealType: ['dinner'] }),
      tagged({ cuisine: ['north-indian'], mealType: ['dinner'] }),
    ];
    const results = discoverCombinations(listings, { minMatches: 3 });
    const keys = results.map((r) => r.key);
    assert.ok(!keys.includes('cuisine=south-indian&mealType=dinner'));
    assert.ok(!keys.includes('cuisine=north-indian&mealType=breakfast'));
    // The two combinations that DO genuinely co-occur 3x are still found.
    assert.ok(keys.includes('cuisine=south-indian&mealType=breakfast'));
    assert.ok(keys.includes('cuisine=north-indian&mealType=dinner'));
  });

  test('no theoretical combination is proposed without at least one real listing embodying it', () => {
    // cuisine values and locality values that individually exist in the
    // dataset, but no single listing ever has both south-indian AND
    // koramangala together — a blind Cartesian product would still propose
    // {cuisine=south-indian, locality=koramangala}; this must not appear.
    const listings = [
      tagged({ cuisine: ['south-indian'], locality: ['indiranagar'] }),
      tagged({ cuisine: ['south-indian'], locality: ['indiranagar'] }),
      tagged({ cuisine: ['south-indian'], locality: ['indiranagar'] }),
      tagged({ cuisine: ['north-indian'], locality: ['koramangala'] }),
      tagged({ cuisine: ['north-indian'], locality: ['koramangala'] }),
      tagged({ cuisine: ['north-indian'], locality: ['koramangala'] }),
    ];
    const results = discoverCombinations(listings, { minMatches: 3 });
    const keys = results.map((r) => r.key);
    assert.ok(!keys.includes('cuisine=south-indian&locality=koramangala'));
    assert.ok(!keys.includes('cuisine=north-indian&locality=indiranagar'));
  });
});

describe('discoverCombinations — specific 2-dimension intersections', () => {
  test('cuisine + price intersection', () => {
    const listings = [
      tagged({ cuisine: ['biryani'], price: ['under-100'] }),
      tagged({ cuisine: ['biryani'], price: ['under-100'] }),
      tagged({ cuisine: ['biryani'], price: ['under-100'] }),
      tagged({ cuisine: ['biryani'], price: ['under-50'] }), // different price band
    ];
    const results = discoverCombinations(listings, { minMatches: 3 });
    const match = results.find((r) => r.key === 'cuisine=biryani&price=under-100');
    assert.ok(match);
    assert.equal(match.count, 3);
  });

  test('cuisine + mealType intersection', () => {
    const listings = [
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'] }),
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'] }),
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'] }),
      tagged({ cuisine: ['south-indian'], mealType: ['lunch'] }),
    ];
    const results = discoverCombinations(listings, { minMatches: 3 });
    const match = results.find((r) => r.key === 'cuisine=south-indian&mealType=breakfast');
    assert.ok(match);
    assert.equal(match.count, 3);
  });

  test('dish + price intersection', () => {
    const listings = [
      tagged({ dish: ['masala dosa'], price: ['under-75'] }),
      tagged({ dish: ['masala dosa'], price: ['under-75'] }),
      tagged({ dish: ['masala dosa'], price: ['under-75'] }),
      tagged({ dish: ['masala dosa'], price: ['under-100'] }), // priced higher, different band
    ];
    const results = discoverCombinations(listings, { minMatches: 3 });
    const match = results.find((r) => r.key === 'dish=masala dosa&price=under-75');
    assert.ok(match);
    assert.equal(match.count, 3);
  });

  test('mealType + locality intersection', () => {
    const listings = [
      tagged({ mealType: ['lunch'], locality: ['koramangala'] }),
      tagged({ mealType: ['lunch'], locality: ['koramangala'] }),
      tagged({ mealType: ['lunch'], locality: ['koramangala'] }),
      tagged({ mealType: ['lunch'], locality: ['indiranagar'] }),
    ];
    const results = discoverCombinations(listings, { minMatches: 3 });
    const match = results.find((r) => r.key === 'mealType=lunch&locality=koramangala');
    assert.ok(match);
    assert.equal(match.count, 3);
  });
});

describe('discoverCombinations — higher-order combinations', () => {
  test('a 3-dimension combination is found when the real dataset supports it', () => {
    const listings = [
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'], price: ['under-50'] }),
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'], price: ['under-50'] }),
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'], price: ['under-50'] }),
      // A near-miss: matches on 2 of the 3 dimensions only.
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'], price: ['under-100'] }),
    ];
    const results = discoverCombinations(listings, { minSize: 2, maxSize: 3, minMatches: 3 });
    const threeDim = results.find((r) => r.key === 'cuisine=south-indian&mealType=breakfast&price=under-50');
    assert.ok(threeDim);
    assert.equal(threeDim.count, 3);
  });

  test('a 3-dimension combination is rejected when only 2 listings satisfy all three dimensions, even though the 2-dimension projection clears the bar', () => {
    const listings = [
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'], price: ['under-50'] }),
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'], price: ['under-50'] }),
      // These two match cuisine+mealType (4 total) but NOT price=under-50.
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'], price: ['under-100'] }),
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'], price: ['under-100'] }),
    ];
    const results = discoverCombinations(listings, { minSize: 2, maxSize: 3, minMatches: 3 });
    const keys = results.map((r) => r.key);
    // The 2-dim projection has 4 matches -> included.
    assert.ok(keys.includes('cuisine=south-indian&mealType=breakfast'));
    // The 3-dim combination only has 2 matches -> excluded.
    assert.ok(!keys.includes('cuisine=south-indian&mealType=breakfast&price=under-50'));
  });

  test('does not search beyond maxSize even if more listings would support it', () => {
    const listings = Array.from({ length: 5 }, () =>
      tagged({ cuisine: ['south-indian'], mealType: ['breakfast'], dish: ['dosa'], price: ['under-50'] })
    );
    const results = discoverCombinations(listings, { minSize: 2, maxSize: 3, minMatches: 3 });
    // No 4-dimension key should appear when maxSize is 3.
    const fourDimKey = results.find((r) => r.combo.length === 4);
    assert.equal(fourDimKey, undefined);
    // But the 3-dimension combinations that DO fit within maxSize are found.
    assert.ok(results.some((r) => r.combo.length === 3));
  });
});

describe('comboKey', () => {
  test('produces the same key regardless of input order (canonical ordering)', () => {
    const comboA = [
      { dim: 'price', value: 'under-50' },
      { dim: 'cuisine', value: 'biryani' },
    ];
    const comboB = [
      { dim: 'cuisine', value: 'biryani' },
      { dim: 'price', value: 'under-50' },
    ];
    assert.equal(comboKey(comboA), comboKey(comboB));
  });
});

describe('listingMatchesCombo', () => {
  test('requires every pair in the combo to match (AND, not OR)', () => {
    const tags = { cuisine: ['south-indian'], price: ['under-50'] };
    const combo = [
      { dim: 'cuisine', value: 'south-indian' },
      { dim: 'price', value: 'under-75' }, // not in tags.price
    ];
    assert.equal(listingMatchesCombo(tags, combo), false);
  });

  test('matches when every pair is present', () => {
    const tags = { cuisine: ['south-indian'], price: ['under-50', 'under-75', 'under-100'] };
    const combo = [
      { dim: 'cuisine', value: 'south-indian' },
      { dim: 'price', value: 'under-75' },
    ];
    assert.equal(listingMatchesCombo(tags, combo), true);
  });
});
