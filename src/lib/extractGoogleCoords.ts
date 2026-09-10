// Mirrors web/src/lib/extractGoogleCoords.ts — split out of googleMapsLink.ts
// into its own file with zero imports so it stays directly unit-testable
// under plain Node (that file's ./supabase import breaks strict ESM
// resolution the moment the file is evaluated, even for an unrelated export).
//
// Priority order is deliberate, not incidental — confirmed live against a
// real share link ("Vigneshwara Tiffens", maps.app.goo.gl/ek3KnmaGp6iHB5U79):
// its resolved URL carries BOTH `@12.9344627,77.547142,12z` (the map's
// viewport center/zoom, ~20km from the actual restaurant) AND
// `!3d12.972322!4d77.7344565` (the place's own precise geocoded coordinate).
// Checking `@` first silently returned the viewport point as if it were the
// listing's location. `!3d!4d` and `?q=` are both tied to the specific place/
// coordinate being shared and are checked first now; `@` is purely "where
// the map happened to be centered on load" and is only trusted when neither
// of the more specific patterns is present (e.g. a raw dropped-pin share,
// which carries no place-data blob at all).
export function extractGoogleCoordsFromUrl(url: string): { latitude: number; longitude: number; source: 'google' } | null {
  // A Directions URL's own @lat,lng is only the route's viewport, not the
  // destination — confirmed live: a "/maps/dir/.../@lat,lng,zoom" link can
  // carry a plausible-looking @ coordinate that's nowhere near either
  // endpoint. Some variants also embed the destination via a different,
  // undocumented convention (!1d<lng>!2d<lat>) this function doesn't parse.
  // Silently returning @ here would risk saving a restaurant at the wrong
  // end of a route with no error shown — refuse outright instead.
  if (/\/maps\/dir\//.test(url)) return null;

  // ...!3d12.9716!4d77.5946 (embedded in some place share links) — the
  // place's own precise coordinate when present, most trustworthy of the three.
  const dMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (dMatch) return { latitude: parseFloat(dMatch[1]), longitude: parseFloat(dMatch[2]), source: 'google' };

  // ...?q=12.9716,77.5946 or &q=12.9716,77.5946 — an explicitly shared coordinate.
  const qMatch = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (qMatch) return { latitude: parseFloat(qMatch[1]), longitude: parseFloat(qMatch[2]), source: 'google' };

  // .../@12.9716,77.5946,15z — the map viewport only. Last resort: this is
  // the ONLY coordinate present for a raw dropped-pin share, but for a named
  // place it can be a wide, zoomed-out regional center rather than the pin.
  const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) return { latitude: parseFloat(atMatch[1]), longitude: parseFloat(atMatch[2]), source: 'google' };

  return null;
}
