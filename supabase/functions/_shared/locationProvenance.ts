// Location provenance (Stage 2A, 0015). Pure helpers, no Supabase client and
// no Deno-specific imports — deliberately dependency-free (same reasoning as
// placeRanking.ts) so the repo's Node test runner can import this directly
// (see tests/locationProvenance.test.mjs) without a Deno runtime.
//
// This is NOT the Google-verification stage. Nothing here enforces provider
// presence or corrects a coordinate on its own — see 0015's own migration
// header for the full design rationale these functions implement.

export function isValidProviderPlaceIds(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

/**
 * When an admin's `update` payload moves the pin (touches latitude and/or
 * longitude) and doesn't already say why, that move IS the location
 * provenance event: an admin looking at a listing and explicitly
 * repositioning its coordinate is a real, happening-right-now human
 * confirmation of that point — categorically different from guessing at a
 * pre-existing listing's unknown history (which 0015's own migration
 * deliberately leaves alone). Returns only the fields that should be ADDED
 * to the update — an explicit location_source/confidence/etc. already
 * present in `fields` is left completely alone, so a caller that knows
 * better (e.g. "this admin move was itself based on a provider's
 * suggestion, not a personal site visit") can always say so precisely
 * instead of getting this default.
 *
 * Returns {} (nothing to add) when the payload doesn't touch the coordinate
 * at all — editing a listing's name/price/note must never touch location
 * provenance as a side effect.
 */
export function computeLocationProvenanceOnMove(
  fields: Record<string, unknown>,
  adminEmail: string,
  nowIso: string = new Date().toISOString()
): Record<string, unknown> {
  const movesCoordinate = 'latitude' in fields || 'longitude' in fields;
  if (!movesCoordinate) return {};

  const result: Record<string, unknown> = {};
  if (!('location_source' in fields)) result.location_source = 'admin';
  if (!('location_confidence' in fields)) result.location_confidence = 'human_confirmed';
  if (!('location_verified_at' in fields)) result.location_verified_at = nowIso;
  if (!('location_verified_by' in fields)) result.location_verified_by = adminEmail;
  return result;
}
