// Pure validation for a community review draft (listing_reviews, migration
// 0022). Zero imports on purpose — split out from reviews.ts, which imports
// ./supabase, so this stays directly unit-testable under plain Node (same
// reasoning as extractGoogleCoords.ts being split out of googleMapsLink.ts).

// Mirrors the DB's own listing_reviews_not_empty/review_text length CHECK
// constraints exactly, so a bad submission is rejected client-side with a
// real message instead of surfacing as a raw Postgres error.
export const REVIEW_TEXT_MAX_LENGTH = 500;
export const MAX_REVIEW_PHOTOS = 3;

export type ReviewValidation =
  | { ok: true; reviewText: string | null }
  | { ok: false; error: string };

// A rating alone, review text alone, or both is fine — the one thing that
// isn't is submitting neither, which the form has no other way to prevent
// (there's no "submit" affordance that isn't already gated behind at least
// touching one of the two fields, but a user can clear both back to empty
// before pressing Submit).
export function validateReviewDraft(rating: number | null, reviewText: string): ReviewValidation {
  const trimmed = reviewText.trim();
  if (rating == null && trimmed.length === 0) {
    return { ok: false, error: 'Add a rating or write a short review.' };
  }
  if (trimmed.length > REVIEW_TEXT_MAX_LENGTH) {
    return { ok: false, error: `Keep your review under ${REVIEW_TEXT_MAX_LENGTH} characters.` };
  }
  return { ok: true, reviewText: trimmed.length > 0 ? trimmed : null };
}
