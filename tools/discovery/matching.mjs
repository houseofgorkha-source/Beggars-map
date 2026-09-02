// Match-confidence helpers for price-verification evidence. Never used to
// auto-approve anything — only to flag how confidently a piece of found
// evidence can be attributed to a *specific* discovered candidate, as
// opposed to a same/similarly-named branch elsewhere in the city (Bengaluru
// darshini/udupi naming is highly repetitive — "New Udupi Grand" and "Udupi
// Upahar" each have many unrelated branches; name-only matching is not safe).

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenOverlap(a, b) {
  const ta = new Set(normalize(a).split(' ').filter(Boolean));
  const tb = new Set(normalize(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

/**
 * @param {{ candidateName: string, candidateAddress: string, evidenceLocationText: string | null }} args
 * @returns {'high' | 'medium' | 'low'}
 *
 * Deliberately capped at 'medium' on name overlap alone: a name match with
 * no corroborating street/locality overlap is exactly the "Udupi Darshini,
 * Koramangala vs Udupi Darshini, Whitefield" trap. Only an address/locality
 * token overlap against the candidate's own Places-API formatted_address
 * earns 'high'.
 */
export function matchConfidence({ candidateName, candidateAddress, evidenceLocationText }) {
  if (!evidenceLocationText) return 'low';
  const addressOverlap = tokenOverlap(candidateAddress, evidenceLocationText);
  const nameOverlap = tokenOverlap(candidateName, evidenceLocationText);
  if (addressOverlap >= 0.2) return 'high';
  if (nameOverlap >= 0.4) return 'medium';
  return 'low';
}

// Product-policy correction (2026-09-01, refined same day): Beggars Map
// answers "where can I eat a proper breakfast/lunch/dinner/substantial meal
// for ₹100 or less" — not "which restaurant has any single item ≤₹100."
// A ₹10 vada, one roti, tea, coffee, or a single piece of chicken does NOT
// qualify a restaurant on its own, however cheap. A genuinely substantial
// single dish (a full biryani, a meal-sized rice bowl) MAY qualify by
// itself — see SUBSTANTIAL_SINGLE_DISH below — but this is never inferred
// by summing/combining separate individual menu items; it has to be one
// offering the source itself presents as a full meal.
export const OFFERING_TYPES = ['BREAKFAST', 'MEAL', 'THALI', 'COMBO', 'SUBSTANTIAL_SINGLE_DISH', 'SINGLE_ITEM'];

// For BREAKFAST/MEAL/THALI/COMBO: either a named-offering keyword, or the
// description visibly joins 2+ components via a connector (see
// looksLikeCompleteMeal below).
const QUALIFYING_KEYWORDS = [
  'thali',
  'combo',
  'combination',
  'meal',
  'meals',
  'breakfast',
  'full meal',
  'set menu',
  'tiffin',
  'unlimited',
  'lunch plate',
  'plate meal',
];

// For SUBSTANTIAL_SINGLE_DISH only: a dish that is culturally/practically a
// complete meal on its own, even served as a single named item — e.g. a
// full biryani. Deliberately does NOT include bare "chicken"/"full
// chicken"/"half chicken" without "meal" — a plain chicken portion is not
// automatically a meal (matches the explicit "single piece of chicken does
// NOT qualify" rule); "chicken meal" is covered via QUALIFYING_KEYWORDS'
// "meal" instead.
const SUBSTANTIAL_DISH_KEYWORDS = ['biryani', 'meal-sized', 'meal sized', 'rice bowl', 'family pack', 'complete meal', 'substantial meal'];

const CONNECTOR_PATTERN = /\+|,| and | with |&/i;

/**
 * Cheap, deliberately conservative text signal for "this description reads
 * as more than one component" — either a named-offering keyword (thali,
 * combo, meal, breakfast, ...) or two-or-more items visibly joined by a
 * connector (+, comma, "and", "with", &). Per product policy, this is
 * never inferred by silently summing unrelated individual menu prices —
 * it only looks at the text of a single evidence description a human/
 * reviewer actually entered for a single qualifying offering.
 */
export function looksLikeCompleteMeal(description) {
  if (!description) return false;
  const text = description.toLowerCase();
  if (QUALIFYING_KEYWORDS.some((k) => text.includes(k))) return true;
  if (CONNECTOR_PATTERN.test(text)) {
    const segments = text.split(CONNECTOR_PATTERN).map((s) => s.trim()).filter(Boolean);
    return segments.length >= 2 && segments.every((s) => s.length >= 2);
  }
  return false;
}

/**
 * Text signal for "this single dish is substantial enough to reasonably be
 * a complete meal on its own" (e.g. "full biryani"). Reuses
 * looksLikeCompleteMeal as a fallback so a description like "substantial
 * chicken meal" still passes via its own "meal" keyword.
 */
export function looksLikeSubstantialDish(description) {
  if (!description) return false;
  const text = description.toLowerCase();
  if (SUBSTANTIAL_DISH_KEYWORDS.some((k) => text.includes(k))) return true;
  return looksLikeCompleteMeal(description);
}

/**
 * The hard qualification gate for HUMAN_VERIFIED_LE_100 / APPROVE_LE_100.
 * Requires BOTH:
 *   - an explicit offeringType, one of BREAKFAST/MEAL/THALI/COMBO/
 *     SUBSTANTIAL_SINGLE_DISH (SINGLE_ITEM is a valid tag for
 *     record-keeping but can never qualify)
 *   - the description itself independently backing that tag up —
 *     looksLikeCompleteMeal for the first four, looksLikeSubstantialDish
 *     for SUBSTANTIAL_SINGLE_DISH
 * Failing either means "not a qualifying complete meal" — a single cheap
 * item (Vada ₹10, one roti, tea, coffee, a single piece of chicken, any
 * lone snack/side) fails both and must never be approved on its own, and a
 * mislabeled tag (e.g. tagging bare "Vada" as MEAL) still fails because the
 * text itself doesn't back it up.
 */
export function classifyOffering({ description, offeringType }) {
  if (!offeringType || !OFFERING_TYPES.includes(offeringType)) {
    return { qualifies: false, reason: `offering_type must be one of ${OFFERING_TYPES.join('/')} (got ${JSON.stringify(offeringType ?? null)})` };
  }
  if (offeringType === 'SINGLE_ITEM') {
    return { qualifies: false, reason: 'a single item, however cheap, is not a qualifying complete meal' };
  }
  if (offeringType === 'SUBSTANTIAL_SINGLE_DISH') {
    if (!looksLikeSubstantialDish(description)) {
      return {
        qualifies: false,
        reason: 'evidence text does not clearly describe a substantial, meal-sized single dish (e.g. a full biryani) — a small individual item does not qualify',
      };
    }
    return { qualifies: true, reason: null };
  }
  if (!looksLikeCompleteMeal(description)) {
    return {
      qualifies: false,
      reason: 'evidence text does not clearly describe multiple components or a named meal/thali/combo/breakfast offering',
    };
  }
  return { qualifies: true, reason: null };
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Duplicate-risk check for an about-to-be-imported candidate against one
 * already-existing local listing. Deliberately conservative/loose: this
 * decides whether to STOP an import as "possibly a duplicate," so it's
 * tuned to over-flag rather than under-flag. Two independent trip-wires:
 *   - close by (<150m) AND at least some name overlap, or
 *   - strong name overlap (>=80%) AND merely nearby (<500m) — catches a
 *     same-brand listing entered with slightly different coordinates.
 * Either firing means "ambiguous — a human should look," not "confirmed
 * duplicate" — callers should STOP rather than silently import OR silently
 * skip.
 */
export function duplicateRisk(candidate, existingListing) {
  const distanceKm = haversineKm(candidate.latitude, candidate.longitude, existingListing.latitude, existingListing.longitude);
  const nameOverlapRatio = tokenOverlap(candidate.name, existingListing.name);
  const flagged = (distanceKm < 0.15 && nameOverlapRatio >= 0.4) || (nameOverlapRatio >= 0.8 && distanceKm < 0.5);
  return { flagged, distanceKm, nameOverlapRatio };
}
