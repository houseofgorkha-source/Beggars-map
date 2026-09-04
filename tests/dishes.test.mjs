// Covers web/src/lib/dishes.ts and src/lib/dishes.ts — the structured
// dish/price entries, star rating, and "Review" feature added to Add
// Listing.
//
// FINAL MVP DECISION (2026-09-04): after several designs in one day (a
// keyword/connector gate, a blocklist + quantity-prefix heuristic, a
// proposed-but-never-built self-declaration checkbox, and a bare-beverage +
// leading-quantity + connector-escape combination), the product decision
// landed on price range as the ONLY automatic qualification rule: ₹30-₹100
// inclusive, nothing else. There is no meal/snack classifier, no
// blocklist, no keyword, quantity, or connector detection. "Dosa ₹50",
// "Biryani ₹90", "1 Idli ₹30", "2 boiled eggs ₹30", and "Tea ₹30" are all
// valid dish entries. Questionable listings are handled through the
// existing report flow and admin moderation, not algorithmic food
// classification. This deliberately does NOT reuse tools/discovery/
// matching.mjs's classifyOffering — that judges secondhand discovery-
// research evidence, a different problem from a user describing their own
// listing.
//
// Every test here runs against BOTH platforms' copies (same convention as
// tests/placeRanking.test.mjs) so they can't silently drift.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as web from '../web/src/lib/dishes.ts';
import * as mobile from '../src/lib/dishes.ts';

const IMPLS = [
  ['web', web],
  ['mobile', mobile],
];

for (const [platform, impl] of IMPLS) {
  const {
    isValidDishEntry,
    parseDishes,
    formatDishes,
    minDishPrice,
    validateDishDrafts,
    MIN_DISH_PRICE,
    MAX_DISH_PRICE,
    PRICE_RANGE_ERROR,
  } = impl;

  describe(`dishes (${platform})`, () => {
    describe('price range constants', () => {
      test('MIN_DISH_PRICE is 30, MAX_DISH_PRICE is 100', () => {
        assert.equal(MIN_DISH_PRICE, 30);
        assert.equal(MAX_DISH_PRICE, 100);
      });
    });

    describe('isValidDishEntry', () => {
      test('accepts a well-formed entry at the minimum price', () => {
        assert.equal(isValidDishEntry({ dish: 'Thali', price: 30 }), true);
      });

      test('accepts a well-formed entry at the maximum price', () => {
        assert.equal(isValidDishEntry({ dish: 'Thali', price: 100 }), true);
      });

      test('rejects a price below ₹30', () => {
        assert.equal(isValidDishEntry({ dish: 'Thali', price: 29 }), false);
      });

      test('rejects a price above ₹100', () => {
        assert.equal(isValidDishEntry({ dish: 'Thali', price: 101 }), false);
      });

      test('rejects a blank dish name', () => {
        assert.equal(isValidDishEntry({ dish: '  ', price: 60 }), false);
      });

      test('rejects a non-integer price', () => {
        assert.equal(isValidDishEntry({ dish: 'Thali', price: 60.5 }), false);
      });

      test('rejects non-objects and missing fields', () => {
        assert.equal(isValidDishEntry(null), false);
        assert.equal(isValidDishEntry('Dosa'), false);
        assert.equal(isValidDishEntry({ dish: 'Thali' }), false);
        assert.equal(isValidDishEntry({ price: 60 }), false);
      });

      // Price/shape is the ONLY gate — any dish name qualifies as long as
      // the shape and price range are satisfied.
      test('any dish name qualifies on price/shape alone, including single items', () => {
        for (const dish of ['Vada', 'Idli', 'Roti', 'Chapati', 'Tea', 'Coffee', '1 Idli', '2 boiled eggs']) {
          assert.equal(isValidDishEntry({ dish, price: 30 }), true, `"${dish}" must be valid at ₹30`);
        }
      });
    });

    describe('parseDishes', () => {
      test('returns [] for null — every pre-existing listing', () => {
        assert.deepEqual(parseDishes(null), []);
      });

      test('returns [] for undefined and non-arrays', () => {
        assert.deepEqual(parseDishes(undefined), []);
        assert.deepEqual(parseDishes('not an array'), []);
        assert.deepEqual(parseDishes({ dish: 'Thali', price: 60 }), []);
      });

      test('parses a valid array and trims dish names', () => {
        assert.deepEqual(parseDishes([{ dish: '  Masala Dosa  ', price: 60 }]), [{ dish: 'Masala Dosa', price: 60 }]);
      });

      test('drops entries below the ₹30 floor rather than throwing', () => {
        const input = [{ dish: 'Thali', price: 60 }, { dish: 'Vada', price: 10 }, { dish: 'Meals', price: 40 }];
        assert.deepEqual(parseDishes(input), [
          { dish: 'Thali', price: 60 },
          { dish: 'Meals', price: 40 },
        ]);
      });

      test('drops malformed entries rather than throwing, keeping the valid ones', () => {
        const input = [{ dish: 'Thali', price: 60 }, { dish: '', price: 40 }, 'garbage', { dish: 'Meals', price: 40 }];
        assert.deepEqual(parseDishes(input), [
          { dish: 'Thali', price: 60 },
          { dish: 'Meals', price: 40 },
        ]);
      });
    });

    describe('formatDishes', () => {
      test('renders a plain-language sentence, not a table', () => {
        const entries = [
          { dish: 'Masala Dosa', price: 60 },
          { dish: 'Rice Meals', price: 80 },
          { dish: 'Idli Vada', price: 40 },
        ];
        assert.equal(formatDishes(entries), 'Masala Dosa ₹60, Rice Meals ₹80, Idli Vada ₹40');
      });

      test('a single entry has no trailing comma', () => {
        assert.equal(formatDishes([{ dish: 'Thali', price: 60 }]), 'Thali ₹60');
      });

      test('empty entries produce an empty string', () => {
        assert.equal(formatDishes([]), '');
      });
    });

    describe('minDishPrice', () => {
      test('returns the cheapest entry\'s price', () => {
        const entries = [
          { dish: 'Thali', price: 60 },
          { dish: 'Meals', price: 80 },
          { dish: 'Combo', price: 40 },
        ];
        assert.equal(minDishPrice(entries), 40);
      });

      test('returns null for an empty array', () => {
        assert.equal(minDishPrice([]), null);
      });

      test('a single entry is its own minimum', () => {
        assert.equal(minDishPrice([{ dish: 'Thali', price: 60 }]), 60);
      });
    });

    describe('validateDishDrafts', () => {
      test('one complete Dish + Price pair is valid', () => {
        const result = validateDishDrafts([{ dish: 'Dosa', price: '60' }]);
        assert.equal(result.ok, true);
        assert.deepEqual(result.entries, [{ dish: 'Dosa', price: 60 }]);
        assert.equal(result.priceRupees, 60);
      });

      test('an empty dish name cannot form a valid pair', () => {
        const result = validateDishDrafts([{ dish: '', price: '60' }]);
        assert.equal(result.ok, false);
      });

      test('an empty price cannot form a valid pair', () => {
        const result = validateDishDrafts([{ dish: 'Thali', price: '' }]);
        assert.equal(result.ok, false);
      });

      test('a non-numeric price is rejected', () => {
        const result = validateDishDrafts([{ dish: 'Thali', price: 'abc' }]);
        assert.equal(result.ok, false);
      });

      test('a decimal price is rejected (whole rupees only)', () => {
        const result = validateDishDrafts([{ dish: 'Thali', price: '60.50' }]);
        assert.equal(result.ok, false);
      });

      test('multiple complete pairs are all accepted, priced at the cheapest', () => {
        const result = validateDishDrafts([
          { dish: 'Masala Dosa', price: '60' },
          { dish: 'Rice Meals', price: '80' },
          { dish: 'Thali', price: '35' },
        ]);
        assert.equal(result.ok, true);
        assert.equal(result.entries.length, 3);
        assert.equal(result.priceRupees, 35);
      });

      test('a fully blank added row is ignored, not an error (the "+ Add more" case)', () => {
        const result = validateDishDrafts([
          { dish: 'Dosa', price: '60' },
          { dish: '', price: '' },
        ]);
        assert.equal(result.ok, true);
        assert.equal(result.entries.length, 1);
      });

      test('a half-filled added row IS an error, not silently ignored', () => {
        const result = validateDishDrafts([
          { dish: 'Dosa', price: '60' },
          { dish: 'Rice Meals', price: '' },
        ]);
        assert.equal(result.ok, false);
        assert.match(result.error, /Rice Meals/);
      });

      test('zero complete pairs is rejected — at least one is mandatory', () => {
        const result = validateDishDrafts([{ dish: '', price: '' }]);
        assert.equal(result.ok, false);
      });

      test('an empty drafts array is rejected', () => {
        const result = validateDishDrafts([]);
        assert.equal(result.ok, false);
      });

      // ---- PRICE RULE: ₹30-₹100, both ends inclusive, the ONLY gate -----
      describe('price rule: ₹30-₹100 (the only qualification rule)', () => {
        test('₹29 is rejected', () => {
          const result = validateDishDrafts([{ dish: 'Thali', price: '29' }]);
          assert.equal(result.ok, false);
          assert.equal(result.error, PRICE_RANGE_ERROR);
        });

        test('₹30 is a valid price', () => {
          const result = validateDishDrafts([{ dish: 'Thali', price: '30' }]);
          assert.equal(result.ok, true);
          assert.equal(result.priceRupees, 30);
        });

        test('₹100 is a valid price', () => {
          const result = validateDishDrafts([{ dish: 'Thali', price: '100' }]);
          assert.equal(result.ok, true);
          assert.equal(result.priceRupees, 100);
        });

        test('₹101 is rejected', () => {
          const result = validateDishDrafts([{ dish: 'Thali', price: '101' }]);
          assert.equal(result.ok, false);
          assert.equal(result.error, PRICE_RANGE_ERROR);
        });

        test('the price error message is the exact required copy', () => {
          assert.equal(PRICE_RANGE_ERROR, 'Price must be between ₹30 and ₹100.');
        });
      });

      // ---- FINAL MVP behavior: price is the only gate --------------------
      describe('price is the only qualification rule — no meal/snack classification', () => {
        test('Dosa ₹50 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: 'Dosa', price: '50' }]).ok, true);
        });

        test('Masala Dosa ₹70 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: 'Masala Dosa', price: '70' }]).ok, true);
        });

        test('Biryani ₹90 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: 'Biryani', price: '90' }]).ok, true);
        });

        test('Chicken Rice ₹80 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: 'Chicken Rice', price: '80' }]).ok, true);
        });

        test('Meals ₹80 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: 'Meals', price: '80' }]).ok, true);
        });

        test('Thali ₹100 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: 'Thali', price: '100' }]).ok, true);
        });

        test('Breakfast ₹60 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: 'Breakfast', price: '60' }]).ok, true);
        });

        test('Idli + Vada ₹40 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: 'Idli + Vada', price: '40' }]).ok, true);
        });

        // Explicitly accepted under the final MVP rule, per product
        // decision — no single-item/beverage/quantity/connector heuristic
        // exists anymore. These were rejected under earlier designs; they
        // now pass on price alone, same as any other dish name.
        test('1 Idli ₹30 → pass (no meal-qualification gate in the MVP)', () => {
          assert.equal(validateDishDrafts([{ dish: '1 Idli', price: '30' }]).ok, true);
        });

        test('1 Vada ₹30 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: '1 Vada', price: '30' }]).ok, true);
        });

        test('1 Roti ₹30 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: '1 Roti', price: '30' }]).ok, true);
        });

        test('1 Chapati ₹30 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: '1 Chapati', price: '30' }]).ok, true);
        });

        test('2 boiled eggs ₹30 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: '2 boiled eggs', price: '30' }]).ok, true);
        });

        test('3 bananas ₹30 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: '3 bananas', price: '30' }]).ok, true);
        });

        test('2 samosas ₹30 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: '2 samosas', price: '30' }]).ok, true);
        });

        test('Tea ₹30 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: 'Tea', price: '30' }]).ok, true);
        });

        test('Coffee ₹30 → pass', () => {
          assert.equal(validateDishDrafts([{ dish: 'Coffee', price: '30' }]).ok, true);
        });

        // The Iyer Mess case, updated for the final rule: its own research
        // records "Vada ₹10" as a real individual-item price. That still
        // fails — not because "Vada" is a single item, but purely because
        // ₹10 is under the ₹30 floor. A hypothetical "Vada ₹70" now
        // legitimately PASSES under the final MVP rule — this is the
        // accepted tradeoff of "price is the only automatic gate," not a
        // regression. Nothing here writes to or reads the real Iyer Mess
        // listing.
        test('the Iyer Mess case: "Vada ₹10" is rejected on price alone; "Vada ₹70" now passes', () => {
          const belowFloor = validateDishDrafts([{ dish: 'Vada', price: '10' }]);
          assert.equal(belowFloor.ok, false);
          assert.equal(belowFloor.error, PRICE_RANGE_ERROR);

          const inRange = validateDishDrafts([{ dish: 'Vada', price: '70' }]);
          assert.equal(inRange.ok, true);
        });

        test('one out-of-range row among multiple still fails on the first bad row', () => {
          const result = validateDishDrafts([
            { dish: 'Dosa', price: '60' },
            { dish: 'Tea', price: '20' },
          ]);
          assert.equal(result.ok, false);
          assert.equal(result.error, PRICE_RANGE_ERROR);
        });
      });
    });
  });
}
