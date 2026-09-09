// Covers web/src/lib/reviewValidation.ts — the pure validation core behind
// the community review form (listing_reviews / listing_review_photos,
// migration 0022). Web-only feature (Phase 2 of the review/correction plan
// — mobile is intentionally paused, see AGENTS.md), so unlike dishes.test.mjs
// there is only one platform's copy to test here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateReviewDraft, REVIEW_TEXT_MAX_LENGTH, MAX_REVIEW_PHOTOS } from '../web/src/lib/reviewValidation.ts';

describe('constants', () => {
  test('REVIEW_TEXT_MAX_LENGTH is 500, MAX_REVIEW_PHOTOS is 3', () => {
    assert.equal(REVIEW_TEXT_MAX_LENGTH, 500);
    assert.equal(MAX_REVIEW_PHOTOS, 3);
  });
});

describe('validateReviewDraft', () => {
  test('a rating alone is valid', () => {
    const result = validateReviewDraft(4, '');
    assert.equal(result.ok, true);
    assert.equal(result.reviewText, null);
  });

  test('review text alone is valid', () => {
    const result = validateReviewDraft(null, 'Great food, friendly staff');
    assert.equal(result.ok, true);
    assert.equal(result.reviewText, 'Great food, friendly staff');
  });

  test('both a rating and text is valid', () => {
    const result = validateReviewDraft(5, 'Loved it');
    assert.equal(result.ok, true);
    assert.equal(result.reviewText, 'Loved it');
  });

  test('neither rating nor text is rejected', () => {
    const result = validateReviewDraft(null, '');
    assert.equal(result.ok, false);
    assert.match(result.error, /add a rating or write/i);
  });

  test('whitespace-only text with no rating is treated as empty and rejected', () => {
    const result = validateReviewDraft(null, '   ');
    assert.equal(result.ok, false);
  });

  test('text is trimmed before being stored', () => {
    const result = validateReviewDraft(null, '  Great value  ');
    assert.equal(result.ok, true);
    assert.equal(result.reviewText, 'Great value');
  });

  test('text at exactly the max length is valid', () => {
    const text = 'a'.repeat(REVIEW_TEXT_MAX_LENGTH);
    const result = validateReviewDraft(null, text);
    assert.equal(result.ok, true);
    assert.equal(result.reviewText.length, REVIEW_TEXT_MAX_LENGTH);
  });

  test('text over the max length is rejected', () => {
    const text = 'a'.repeat(REVIEW_TEXT_MAX_LENGTH + 1);
    const result = validateReviewDraft(null, text);
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(String(REVIEW_TEXT_MAX_LENGTH)));
  });

  test('a rating of 1 through 5 is accepted alongside empty text', () => {
    for (const star of [1, 2, 3, 4, 5]) {
      const result = validateReviewDraft(star, '');
      assert.equal(result.ok, true, `star=${star}`);
    }
  });
});
