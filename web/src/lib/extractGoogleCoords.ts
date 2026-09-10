// The three URL shapes a Google-embedded coordinate can appear in. Split out
// of googleMapsLink.ts into its own file with zero imports (that file pulls
// in ./supabase, which breaks plain-Node module resolution the moment the
// file is evaluated — even for an unrelated export) so this stays directly
// unit-testable, same reasoning as placeRanking.ts.
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

// A coordinate a human copied verbatim from Google Maps' own "What's here?"
// (desktop right-click) / long-press-and-copy (mobile) feature — the exact
// fallback for links that carry no coordinate at all (confirmed live: some
// real share links resolve to a page with only an opaque place ID, nothing
// extractGoogleCoordsFromUrl above can find). Whole-string match only (never
// a substring inside a URL, so this can never misfire against a real link)
// and range-validated, so a garbage paste is rejected rather than silently
// producing an out-of-range "coordinate". Tagged 'user_pin', not 'google' —
// this is a human manually providing an exact point, the same trust tier as
// a map pin, not a claim about which provider it came from.
export function extractLatLngFromText(text: string): { latitude: number; longitude: number; source: 'user_pin' } | null {
  const match = text.trim().match(/^(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!match) return null;

  const latitude = parseFloat(match[1]);
  const longitude = parseFloat(match[2]);
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  return { latitude, longitude, source: 'user_pin' };
}

// When a place URL carries no coordinate at all (the CID-only case above),
// its /maps/place/<segment>/ path is still present and still carries the
// business name (and usually its full address) — confirmed against the real
// captured Nallurahalli URL. Used to pre-fill the listing name/address
// instead of leaving the user to retype it, even when no coordinate could
// be extracted at all.
export function extractPlaceNameFromUrl(url: string): { name: string; address: string | null } | null {
  const match = url.match(/\/maps\/place\/([^/?#]+)/);
  if (!match) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1].replace(/\+/g, ' '));
  } catch {
    decoded = match[1].replace(/\+/g, ' ');
  }
  decoded = decoded.trim();
  if (!decoded) return null;

  // A bare coordinate as the "place" segment (a raw dropped-pin share) is
  // not a business name — nothing useful to pre-fill, and
  // extractGoogleCoordsFromUrl above would already have found this anyway.
  if (/^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(decoded)) return null;

  const commaIndex = decoded.indexOf(',');
  if (commaIndex === -1) return { name: decoded, address: null };
  return { name: decoded.slice(0, commaIndex).trim(), address: decoded.slice(commaIndex + 1).trim() || null };
}
