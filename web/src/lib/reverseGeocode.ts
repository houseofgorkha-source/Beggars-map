// Reverse geocoding for a listing's location — turns the picked lat/lng into
// a short, human-readable locality descriptor ("Indiranagar",
// "Malleswaram", "Basavanagudi") for display on the popup card. Uses OLA's
// reverse-geocode endpoint (api.olamaps.io/places/v1/reverse-geocode)
// — the same provider and API key this app already uses for forward place
// search (see olaPlaces.ts) — rather than introducing a second geocoding
// provider. Deliberately NOT Google's Geocoding API: that's a separate
// billed SKU from the Maps JS API key already in use, and OLA already
// covers this need on the same free tier.
//
// A listing's coordinates never change after creation, so this is called
// once at submission time (AddListingModal.tsx) and the result is stored on
// the row (listings.location_label) rather than re-resolved on every view.
const OLA_BASE = 'https://api.olamaps.io';
const apiKey = import.meta.env.VITE_OLA_MAPS_API_KEY as string | undefined;

type AddressComponent = {
  types: string[];
  long_name: string;
  short_name: string;
};

function componentOf(components: AddressComponent[], type: string): string | undefined {
  return components.find((c) => c.types.includes(type))?.long_name;
}

// Short by design (1-2 words) — a full postal address is neither wanted nor
// useful on a compact popup card. Prefers the neighborhood/locality area
// alone ("Indiranagar", "Basavanagudi") since that's what every real
// listing's coordinates resolve to in practice; falls back to the street
// name alone only when OLA's response has no area component at all, and to
// the city only as a last resort (never state/country — those never add
// anything useful for an app that's Bengaluru-only today). Never combines
// multiple parts into one longer address string.
function buildLabel(components: AddressComponent[]): string | null {
  const area = componentOf(components, 'sublocality') ?? componentOf(components, 'neighborhood');
  if (area) return area;

  const street = componentOf(components, 'route') ?? componentOf(components, 'street_address');
  if (street) return street;

  const city = componentOf(components, 'locality');
  if (city) return city;

  return null;
}

export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  if (!apiKey) return null;

  try {
    const params = new URLSearchParams({ latlng: `${lat},${lon}`, api_key: apiKey });
    const response = await fetch(`${OLA_BASE}/places/v1/reverse-geocode?${params.toString()}`);
    if (!response.ok) return null;

    const data = await response.json();
    const components: AddressComponent[] = data?.results?.[0]?.address_components ?? [];
    return buildLabel(components);
  } catch {
    return null;
  }
}
