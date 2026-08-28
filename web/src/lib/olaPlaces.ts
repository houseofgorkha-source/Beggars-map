// Place/landmark search only — OLA Places autocomplete. Map rendering is
// Google Maps JS API (see googleMaps.ts); this file has no rendering
// responsibility, unlike the pre-migration olaMaps.ts it's revived from
// (that also had vectorStyleUrl/transformRequest/staticMapUrl for MapLibre
// tiles, none of which apply now).
const OLA_BASE = 'https://api.olamaps.io';
const apiKey = import.meta.env.VITE_OLA_MAPS_API_KEY as string | undefined;

export type PlaceSuggestion = {
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
};

export async function searchPlaces(query: string, near?: { latitude: number; longitude: number }): Promise<PlaceSuggestion[]> {
  if (!apiKey || !query.trim()) return [];

  const params = new URLSearchParams({ input: query, api_key: apiKey });
  if (near) params.set('location', `${near.latitude},${near.longitude}`);

  const response = await fetch(`${OLA_BASE}/places/v1/autocomplete?${params.toString()}`);
  if (!response.ok) return [];

  const data = await response.json();
  const predictions: any[] = data.predictions ?? [];

  return predictions
    .map((p) => ({
      placeId: p.place_id as string,
      name: (p.structured_formatting?.main_text ?? p.description ?? '') as string,
      address: (p.structured_formatting?.secondary_text ?? '') as string,
      latitude: p.geometry?.location?.lat as number,
      longitude: p.geometry?.location?.lng as number,
    }))
    .filter((p) => typeof p.latitude === 'number' && typeof p.longitude === 'number');
}
