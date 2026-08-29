// Reverse geocoding for a listing's location — turns the picked lat/lng into
// a short, human-readable descriptor ("100 Feet Road, Indiranagar", or just
// "Indiranagar, Bengaluru" when street-level data isn't available). Uses
// OLA's reverse-geocode endpoint (api.olamaps.io/places/v1/reverse-geocode)
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

// Prefers street + locality-level area ("100 Feet Road, Indiranagar"),
// falls back to just the area + city ("Indiranagar, Bengaluru") when no
// street-level component is available, and falls back further from there —
// never claims a street address the response didn't actually provide.
function buildLabel(components: AddressComponent[]): string | null {
  const street = componentOf(components, 'street_address') ?? componentOf(components, 'route');
  const area = componentOf(components, 'sublocality') ?? componentOf(components, 'neighborhood');
  const city = componentOf(components, 'locality');

  if (street && area) return `${street}, ${area}`;
  if (area && city) return `${area}, ${city}`;
  if (city) return city;
  if (area) return area;
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
