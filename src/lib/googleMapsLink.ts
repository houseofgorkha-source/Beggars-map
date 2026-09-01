import { supabase } from './supabase';

export async function parseGoogleMapsUrl(rawUrl: string): Promise<{ latitude: number; longitude: number } | null> {
  let url = rawUrl.trim();
  if (!url) return null;

  // Short links (maps.app.goo.gl, goo.gl/maps/..., share.google/...) don't
  // carry coordinates themselves — resolved server-side via the same
  // resolve-maps-link Edge Function web already uses (its own fetch isn't
  // subject to the redirect-target restrictions a client fetch can hit).
  // share.google links resolve to a plain google.com/search results page
  // with no coordinates in the URL at all, so that function falls back to an
  // OLA places text search for those and returns latitude/longitude
  // directly instead of a finalUrl to run the regexes below on.
  if (/goo\.gl/.test(url) || /(^|\/\/)share\.google\//.test(url)) {
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

  // .../@12.9716,77.5946,15z
  const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) return { latitude: parseFloat(atMatch[1]), longitude: parseFloat(atMatch[2]) };

  // ...?q=12.9716,77.5946 or &q=12.9716,77.5946
  const qMatch = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (qMatch) return { latitude: parseFloat(qMatch[1]), longitude: parseFloat(qMatch[2]) };

  // ...!3d12.9716!4d77.5946 (embedded in some place share links)
  const dMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (dMatch) return { latitude: parseFloat(dMatch[1]), longitude: parseFloat(dMatch[2]) };

  return null;
}
