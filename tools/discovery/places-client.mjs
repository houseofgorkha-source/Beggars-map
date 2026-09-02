// Thin wrapper around Google Places API (New) Text Search. Requests only
// the fields this pipeline actually uses — deliberately excludes photos,
// reviews, and editorial summaries, since AGENTS.md-adjacent policy for
// this tool forbids copying that restricted content into Beggars Map.
// Never logs or throws the API key into an error message.

const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

// websiteUri/nationalPhoneNumber/googleMapsUri added Phase 1.9 (2026-09-01)
// — useful matching/research signals (a restaurant's own site is the one
// clean, ToS-safe automatable price source per Phase 1.5's research; a
// phone number is a strong branch-disambiguation signal). These are
// already in the same Pro-tier field bucket as priceLevel/businessStatus/
// primaryType (already being requested), so adding them does not move
// this call to a more expensive SKU. Still excludes photos/reviews/
// editorial content, per policy.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.priceLevel',
  'places.types',
  'places.primaryType',
  'places.businessStatus',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.googleMapsUri',
].join(',');

export class PlacesApiError extends Error {
  constructor(status, body) {
    super(`Places API error ${status}: ${body.slice(0, 500)}`);
    this.status = status;
  }
}

/**
 * @param {{ query: string, area: { name: string, lat: number, lng: number }, radiusMeters: number, maxResults: number, apiKey: string }} args
 * @returns {Promise<Array<object>>} raw `places[]` entries from the API response
 */
export async function textSearch({ query, area, radiusMeters, maxResults, apiKey }) {
  if (!apiKey) throw new Error('textSearch called with no API key.');

  const body = {
    textQuery: query,
    locationBias: {
      circle: {
        center: { latitude: area.lat, longitude: area.lng },
        radius: radiusMeters,
      },
    },
    maxResultCount: Math.min(Math.max(1, maxResults), 20),
  };

  const res = await fetch(TEXT_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new PlacesApiError(res.status, text);
  }

  const data = await res.json();
  return Array.isArray(data.places) ? data.places : [];
}
