// Free reverse geocoding via OpenStreetMap's Nominatim — used only to show a
// human-readable address in the map popup. No API key, but rate-limited to
// light usage; if BeggarsMap gets serious traffic this should move to a paid
// geocoder (or a verified OLA Maps reverse-geocode endpoint).
//
// A listing's coordinates never change after creation, so its resolved
// address never changes either — cache by rounded coordinate (~1m precision)
// to stop every listing popup open from re-querying Nominatim for the same
// spot, which their usage policy explicitly asks callers not to do.
const cache = new Map<string, string | null>();

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const key = cacheKey(lat, lon);
  if (cache.has(key)) return cache.get(key)!;

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=0`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const address = (data.display_name as string | undefined) ?? null;
    cache.set(key, address);
    return address;
  } catch {
    return null;
  }
}
