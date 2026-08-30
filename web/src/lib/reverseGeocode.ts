// Reverse geocoding for a listing's location — turns the picked lat/lng into
// a short, human-readable locality descriptor ("7th Main Road,
// Indiranagar", or just "Malleswaram" when OLA has no street-level data for
// that point) for display on the popup card. Uses OLA's
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

// Short by design (never a full postal address) — prefers "Street, Area"
// when OLA's response has both ("7th Main Road, Indiranagar"), since that's
// more useful/specific than the area name alone while still being short.
// Falls back to the area alone when the response has no street-level data
// for that point (confirmed this genuinely happens for real coordinates —
// not every reverse-geocode result includes a route/street_address
// component), then the street alone in the reverse case, then the city only
// as a last resort (never state/country — those never add anything useful
// for an app that's Bengaluru-only today).
function buildLabel(components: AddressComponent[]): string | null {
  const street = componentOf(components, 'route') ?? componentOf(components, 'street_address');
  const area = componentOf(components, 'sublocality') ?? componentOf(components, 'neighborhood');

  if (street && area) return `${street}, ${area}`;
  if (area) return area;
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
