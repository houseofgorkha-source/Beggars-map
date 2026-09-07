// Covers tools/discovery/import-excel.mjs's minPriceFrom() — the price
// extracted from a human-researched "Menu Details/Notes" cell during
// production import. Fixed 2026-09-08 after a real, confirmed-live bug:
// the original regex excluded a quantity only when followed by a unit
// word ("2nos"/"2pcs"), which missed a bare parenthetical count with no
// unit word ("samosa (2) ₹60") and a leading quantity before an item name
// ("2 idli vada ₹50", "3 chapati , 2 anda roast ₹95") — both misread as
// the listing's price itself (as low as ₹1-2), which would have sorted
// straight to the top of the cheapest-first map.
//
// Importing this module must not trigger main() as a side effect — the
// file itself guards this (`invokedDirectly`), confirmed by these tests
// running without touching any database or spawning `supabase`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { minPriceFrom } from '../tools/discovery/import-excel.mjs';

describe('minPriceFrom — the original bug this fix addresses (bare parenthetical/leading quantities)', () => {
  test('a bare parenthetical quantity with no unit word is not mistaken for a price', () => {
    assert.equal(minPriceFrom('dosa ₹80, roti curry ₹70, samosa (2) ₹60'), 60);
    assert.equal(minPriceFrom('roti (2) ₹60, rumali (2) ₹40, Chicken kebab ₹60'), 40);
    assert.equal(minPriceFrom('roti (2) ₹60, idli (2) ₹40'), 40);
    assert.equal(minPriceFrom('biryani rice ₹90, parota (2) ₹50'), 50);
  });

  test('a leading quantity before an item name is not mistaken for a price', () => {
    assert.equal(minPriceFrom('2 idli vada ₹50, 3 puri ₹45'), 45);
    assert.equal(minPriceFrom('3 chapati , 2 anda roast ₹95, Dosa (2pcs) ₹80'), 80);
    assert.equal(minPriceFrom('2 vada 1 idli ₹70'), 70);
    assert.equal(minPriceFrom('fish curry sabji 1 , 1 sambhar ₹100'), 100);
  });

  test('mixing a unit-suffixed quantity and a bare parenthetical quantity in the same note', () => {
    assert.equal(minPriceFrom('Idiyappam (4pcs) ₹80, kerela porotta (2) ₹50, Appam (2) ₹40'), 40);
    assert.equal(minPriceFrom('vada pav (2 ) ₹50, samosa (2pcs) ₹40'), 40);
    assert.equal(minPriceFrom('Dosa (2pcs) ₹60, parota (2) ₹50'), 50);
  });

  test('the exact 11 real rows confirmed live during the 2026-09-08 dry run all now resolve to their genuine minimum menu price, not a quantity', () => {
    const cases = [
      ['dosa ₹80, roti curry ₹70, samosa (2) ₹60', 60],
      ['roti (2) ₹60, rumali (2) ₹40, Chicken kebab ₹60', 40],
      ['fish curry sabji 1 , 1 sambhar ₹100', 100],
      ['roti (2) ₹60, idli (2) ₹40', 40],
      ['Dosa (2pcs) ₹60, parota (2) ₹50', 50],
      ['3 chapati , 2 anda roast ₹95, Dosa (2pcs) ₹80', 80],
      ['biryani rice ₹90, parota (2) ₹50', 50],
      ['vada pav (2 ) ₹50, samosa (2pcs) ₹40', 40],
      ['2 vada 1 idli ₹70', 70],
      ['2 idli vada ₹50, 3 puri ₹45', 45],
      ['Idiyappam (4pcs) ₹80, kerela porotta (2) ₹50, Appam (2) ₹40', 40],
    ];
    for (const [note, expected] of cases) {
      assert.equal(minPriceFrom(note), expected, `note: ${JSON.stringify(note)}`);
    }
  });
});

describe('minPriceFrom — original unit-suffixed quantity exclusion (pre-existing, must still work)', () => {
  test('still excludes "2nos"-style quantities', () => {
    assert.equal(minPriceFrom('Biryani rice 90, parotha(2nos) 60, rahi ball(2nos) 60'), 60);
  });

  test('still excludes 2no / 2pcs / 2 pcs / 2 piece / 2 pieces variants, any case', () => {
    assert.equal(minPriceFrom('item(2no) 60, real 90'), 60);
    assert.equal(minPriceFrom('item(2PCS) 60, real 90'), 60);
    assert.equal(minPriceFrom('item(2 pcs) 60, real 90'), 60);
    assert.equal(minPriceFrom('item(2 piece) 60, real 90'), 60);
    assert.equal(minPriceFrom('item(2 pieces) 60, real 90'), 60);
  });
});

describe('minPriceFrom — fallback when the note has no ₹ at all (must be unaffected by this fix)', () => {
  test('MANUAL_DISH_OVERRIDES-style raw notes (plain "word number" text, no currency symbol) still parse via the bare-digit fallback, byte-for-byte unchanged', () => {
    // These are the exact raw Menu Details/Notes strings behind
    // import-excel.mjs's own MANUAL_DISH_OVERRIDES entries. minPriceFrom's
    // return value here is ONLY used as the initial "does some price exist
    // at all" validation gate for these 3 rows — the actual imported price
    // comes from the override array's own Math.min(), never from this
    // function, so the pre-existing "2 chapati" bare-quantity limitation
    // below is a real but out-of-scope gap this task did not ask to fix
    // (these rows never reach production with a wrong price because of it).
    // What matters for THIS fix is that the value is identical before and
    // after — confirmed empirically (0 of these 3 changed) — so the
    // validation gate keeps passing exactly as it did before.
    assert.equal(minPriceFrom('raagi Ball Meal 60 South Meal 60'), 60);
    assert.equal(minPriceFrom('Chicken Meal 100 fish meal 90 2 chapati meal 30'), 2);
    assert.equal(minPriceFrom('idli vada- 60 moong dosa 50 55 70 75 adhra meal 80'), 50);
  });

  test('a plain bare-digit note with no ₹ and no quantity markers behaves exactly as before', () => {
    assert.equal(minPriceFrom('thali 90, meals 60'), 60);
  });
});

describe('minPriceFrom — pre-existing behavior, unrelated to this fix, must be preserved', () => {
  test('returns null for non-string input', () => {
    assert.equal(minPriceFrom(null), null);
    assert.equal(minPriceFrom(undefined), null);
    assert.equal(minPriceFrom(42), null);
  });

  test('returns null when no number is found at all', () => {
    assert.equal(minPriceFrom('great food, no prices listed'), null);
  });

  test('strips URLs before extracting — a domain never becomes a price', () => {
    assert.equal(minPriceFrom('see https://example123.com/menu for details, thali ₹90'), 90);
  });

  test('a decimal or longer number is not misread as a bare short price', () => {
    // (?<![\d.]) / (?![\d.]) still applies inside the fallback bare-digit
    // pattern — a postcode or a decimal fragment is not a price.
    assert.equal(minPriceFrom('opp 560102 postcode, thali 60'), 60);
  });

  test('returns the minimum when multiple genuine ₹ prices are present', () => {
    assert.equal(minPriceFrom('thali ₹99, meals ₹60, biryani ₹100'), 60);
  });
});
