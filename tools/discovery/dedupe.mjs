// Merges raw Places API hits (the same restaurant is expected to surface
// under multiple query/area combinations) into one candidate record per
// Google place_id, tracking every (area, query) that discovered it.

/**
 * @param {Array<{ raw: object, area: string, query: string }>} hits
 * @returns {{ candidates: Map<string, object>, totalHits: number, duplicateHits: number }}
 */
export function dedupeHits(hits) {
  const candidates = new Map();
  let duplicateHits = 0;

  for (const { raw, area, query } of hits) {
    const placeId = raw.id;
    if (!placeId) continue; // never fabricate an id for a malformed hit

    // Per-hit provenance, never dropped on merge — area, query, AND the
    // moment this specific hit was discovered (Phase 1.9 requirement).
    const source = { area, query, discovered_at: new Date().toISOString() };

    if (candidates.has(placeId)) {
      duplicateHits += 1;
      candidates.get(placeId).discovery_sources.push(source);
      continue;
    }

    candidates.set(placeId, toCandidate(raw, source));
  }

  return { candidates, totalHits: hits.length, duplicateHits };
}

function toCandidate(raw, firstSource) {
  return {
    place_id: raw.id,
    name: raw.displayName?.text ?? null,
    formatted_address: raw.formattedAddress ?? null,
    latitude: raw.location?.latitude ?? null,
    longitude: raw.location?.longitude ?? null,
    types: Array.isArray(raw.types) ? raw.types : [],
    primary_type: raw.primaryType ?? null,
    business_status: raw.businessStatus ?? null,
    // Google's own coarse price bucket (PRICE_LEVEL_INEXPENSIVE, etc.) —
    // NOT rupee-specific and NOT evidence of a ≤₹100 item. Kept only as a
    // weak signal for a human reviewer, never conflated with verified price.
    google_price_level: raw.priceLevel ?? null,
    // Added Phase 1.9 — same Pro-tier field bucket already being requested,
    // no extra cost. website_uri is the one clean, ToS-safe automatable
    // price-research source (Phase 1.5 finding); phone/maps_uri help with
    // branch disambiguation later.
    website_uri: raw.websiteUri ?? null,
    phone: raw.nationalPhoneNumber ?? null,
    google_maps_uri: raw.googleMapsUri ?? null,
    discovery_sources: [firstSource],
    discovered_at: new Date().toISOString(),
    // Price evidence is a separate, not-yet-implemented step. This pipeline
    // has no menu-pricing source integrated, so every candidate starts
    // here — never invented, never inferred from google_price_level.
    price_evidence_source: null,
    verified_le_100: false,
    verification_status: 'unverified',
  };
}
