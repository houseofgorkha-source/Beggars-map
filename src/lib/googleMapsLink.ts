import { supabase } from './supabase';
import { extractGoogleCoordsFromUrl } from './extractGoogleCoords';

export { extractGoogleCoordsFromUrl };

export type ParsedMapsLink = {
  latitude: number;
  longitude: number;
  // Which provider the returned coordinate actually came from, for location
  // provenance (Stage 2A, 0015) — 'google' when extracted directly from the
  // URL itself, 'ola' when the share.google fallback resolved it through
  // OLA's places search instead. Mirrors web/src/lib/googleMapsLink.ts.
  source: 'google' | 'ola';
};

export async function parseGoogleMapsUrl(rawUrl: string): Promise<ParsedMapsLink | null> {
  let url = rawUrl.trim();
  if (!url) return null;

  // Short links (maps.app.goo.gl, goo.gl/maps/..., share.google/...) don't
  // carry coordinates themselves — resolved server-side via the same
  // resolve-maps-link Edge Function web already uses (its own fetch isn't
  // subject to the redirect-target restrictions a client fetch can hit).
  // share.google links resolve to a plain google.com/search results page
  // with no coordinates in the URL at all, so that function falls back to an
  // OLA places text search for those and returns latitude/longitude
  // directly instead of a finalUrl to run extractGoogleCoordsFromUrl on.
  if (/goo\.gl/.test(url) || /(^|\/\/)share\.google\//.test(url)) {
    try {
      const { data, error } = await supabase.functions.invoke<{ finalUrl?: string; latitude?: number; longitude?: number }>(
        'resolve-maps-link',
        { body: { url } }
      );
      if (error) return null;
      if (typeof data?.latitude === 'number' && typeof data?.longitude === 'number') {
        return { latitude: data.latitude, longitude: data.longitude, source: 'ola' };
      }
      if (!data?.finalUrl) return null;
      url = data.finalUrl;
    } catch {
      return null;
    }
  }

  return extractGoogleCoordsFromUrl(url);
}
