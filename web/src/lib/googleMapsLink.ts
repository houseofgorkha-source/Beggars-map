import { supabase } from './supabase';
import { extractGoogleCoordsFromUrl } from './extractGoogleCoords';

export { extractGoogleCoordsFromUrl };

export type ParsedMapsLink = {
  latitude: number;
  longitude: number;
  // Which provider the returned coordinate actually came from, for location
  // provenance (Stage 2A, 0015) — 'google' when it was extracted directly
  // from the URL itself (Google's own embedded coordinate, via a redirect or
  // the original link — see extractGoogleCoords.ts), 'ola' when the
  // share.google fallback resolved it through OLA's places search instead
  // (see the branch below). Never inferred after the fact — each return
  // statement already knows which case it is.
  source: 'google' | 'ola';
};

export async function parseGoogleMapsUrl(rawUrl: string): Promise<ParsedMapsLink | null> {
  let url = rawUrl.trim();
  if (!url) return null;

  // Covers both of Google's short-link shapes seen in the wild: the Maps
  // app's own share button (maps.app.goo.gl, resolves to a real Maps URL
  // with coordinates) and the general Google share sheet (share.google,
  // resolves to a plain google.com/search results page with no coordinates
  // in the URL at all — the edge function falls back to a places text
  // search for those and returns latitude/longitude directly instead of a
  // finalUrl to run regexes on).
  if (/goo\.gl/.test(url) || /(^|\/\/)share\.google\//.test(url)) {
    // A browser can't follow this redirect itself (Google's redirect target
    // doesn't send permissive CORS headers, so a client-side fetch always
    // throws) — resolved server-side instead via the resolve-maps-link edge
    // function, whose own fetch isn't CORS-restricted. See that function's
    // header comment for the full explanation.
    try {
      const { data, error } = await supabase.functions.invoke<{ finalUrl?: string; latitude?: number; longitude?: number }>(
        'resolve-maps-link',
        { body: { url } }
      );
      if (error) return null;
      if (typeof data?.latitude === 'number' && typeof data?.longitude === 'number') {
        // The OLA-places-search fallback branch — see resolve-maps-link's own
        // header for why this coordinate is OLA's, not Google's, despite the
        // link being a Google share link.
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
