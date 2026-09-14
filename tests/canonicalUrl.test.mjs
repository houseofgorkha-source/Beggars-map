// Covers web/src/lib/canonicalUrl.ts — the pure canonical-URL decision
// logic behind the S6/Batch 3 SEO fix (the <link rel="canonical"> tag
// previously never changed from the homepage, undermining the sitemap's
// ~30 filter/landing URLs).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCanonicalUrl, CANONICAL_ORIGIN } from '../web/src/lib/canonicalUrl.ts';

describe('computeCanonicalUrl', () => {
  test('homepage (no filters) canonicalizes to the bare origin', () => {
    assert.equal(computeCanonicalUrl({}, ''), `${CANONICAL_ORIGIN}/`);
  });

  test('a single active filter (cuisine page) self-canonicalizes with its query string', () => {
    assert.equal(computeCanonicalUrl({ cuisine: 'biryani' }, '?cuisine=biryani'), `${CANONICAL_ORIGIN}/?cuisine=biryani`);
  });

  test('a single active filter of a different dimension (price) also self-canonicalizes', () => {
    assert.equal(computeCanonicalUrl({ price: 'under-50' }, '?price=under-50'), `${CANONICAL_ORIGIN}/?price=under-50`);
  });

  test('an ordinary non-indexable query state (two filters at once) falls back to the homepage, not self', () => {
    assert.equal(
      computeCanonicalUrl({ cuisine: 'biryani', price: 'under-50' }, '?cuisine=biryani&price=under-50'),
      `${CANONICAL_ORIGIN}/`,
      'must not blindly canonicalize every query-parameter combination'
    );
  });

  test('three or more filters at once still falls back to the homepage', () => {
    assert.equal(
      computeCanonicalUrl({ cuisine: 'biryani', price: 'under-50', mealType: 'lunch' }, '?cuisine=biryani&price=under-50&mealType=lunch'),
      `${CANONICAL_ORIGIN}/`
    );
  });
});
