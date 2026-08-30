import { supabase } from './supabase';

export async function parseGoogleMapsUrl(rawUrl: string): Promise<{ latitude: number; longitude: number } | null> {
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
        return { latitude: data.latitude, longitude: data.longitude };
      }
      if (!data?.finalUrl) return null;
      url = data.finalUrl;
    } catch {
      return null;
    }
  }

  const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) return { latitude: parseFloat(atMatch[1]), longitude: parseFloat(atMatch[2]) };

  const qMatch = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (qMatch) return { latitude: parseFloat(qMatch[1]), longitude: parseFloat(qMatch[2]) };

  const dMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (dMatch) return { latitude: parseFloat(dMatch[1]), longitude: parseFloat(dMatch[2]) };

  return null;
}
