// Resolves a Google Maps short link (maps.app.goo.gl / goo.gl / share.google)
// to its final redirect URL.
//
// This can't be done from the browser directly: web/src/lib/googleMapsLink.ts
// used to `fetch()` the short link straight from client code, but a browser
// enforces CORS on cross-origin responses and Google's redirect target
// doesn't send permissive CORS headers — so that fetch throws every single
// time, for every short link, regardless of whether the link itself is
// valid. Deno's fetch (this function runs server-side) has no such
// restriction, so it can follow the redirect and hand the resolved URL back.
//
// share.google links are a genuinely different shape: confirmed (repeatedly,
// against real links) that they redirect to a plain google.com/search
// results page, not a Maps page — there is no lat/lng anywhere in that URL,
// only a place name (?q=) and a Knowledge Graph id. There's no coordinate to
// extract in that case, so this falls back to a text search via the same
// OLA Places autocomplete endpoint the app's own search bar already uses
// (web/src/lib/olaPlaces.ts), biased toward Bengaluru (the app is
// Bengaluru-only today). OLA's own ranking for a bare text query weighs
// proximity over name match — confirmed against a real link where the
// correct place came back 2nd, not 1st — so results are re-ranked by name
// similarity (see bestPlaceMatch) rather than trusting predictions[0].
// Returns that best match's coordinates instead of a finalUrl. This is an
// approximation, not an exact pin — good enough to place the listing, not
// guaranteed to be the identical spot Google's page was showing.
//
// Deploy with:
//   npx supabase functions deploy resolve-maps-link --project-ref nvingzluboafxzxgxxwc
// Requires the OLA_MAPS_API_KEY secret for the search-page fallback:
//   npx supabase secrets set OLA_MAPS_API_KEY=<key> --project-ref nvingzluboafxzxgxxwc

import { bestPlaceMatch as pickBestPlace, predictionsToPoints } from '../_shared/placeRanking.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// OLA's own ranking for a bare text query weighs proximity more than exact
// name match — verified against a real share.google link ("Dhal roti &
// more") where the actual place came back 2nd, not 1st, so blindly taking
// predictions[0] silently returns the wrong business.
//
// The scoring (sliding-window edit distance against the query, plus a
// POI-over-street_address tiebreak for identically-named candidates) now lives
// in ../_shared/placeRanking.ts, shared with — and behaviourally identical to —
// the web and mobile copies. See that module's header for why the type
// tiebreak is needed: OLA returns street-address geocoder artifacts under the
// exact same display name as the real restaurant, and this function's previous
// private copy kept the first candidate on a tie, so it returned whichever OLA
// ranked first (i.e. the nearest), which for "Juicy Spot" is a street address
// 1,080 m from the actual place.
function bestPlaceMatch(query: string, predictions: any[]): { lat: number; lng: number } | null {
  const match = pickBestPlace(query, predictionsToPoints(predictions));
  return match ? { lat: match.lat, lng: match.lng } : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body: { url?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const rawUrl = typeof body.url === 'string' ? body.url : '';
  if (!rawUrl) return json({ error: 'Missing url' }, 400);

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return json({ error: 'Invalid url' }, 400);
  }

  // Only ever resolve Google's own short-link domains — without this check,
  // this function is an open, unauthenticated URL-redirect resolver anyone
  // could point at an arbitrary target (SSRF/abuse), not just Google Maps
  // links.
  const isGoogleShortLink = parsed.hostname === 'goo.gl' || parsed.hostname.endsWith('.goo.gl') || parsed.hostname === 'share.google';
  if (!isGoogleShortLink) {
    return json({ error: 'Only goo.gl / share.google short links are supported' }, 400);
  }

  let resolvedUrl: URL;
  try {
    const response = await fetch(parsed.toString());
    resolvedUrl = new URL(response.url || parsed.toString());
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Failed to resolve link' }, 502);
  }

  // share.google's redirect target — a Search results page, not Maps. Fall
  // back to a places text search on the place name instead of the usual
  // regex-on-URL coordinate extraction, since there's nothing to extract.
  if (resolvedUrl.hostname === 'www.google.com' && resolvedUrl.pathname === '/search') {
    const placeName = resolvedUrl.searchParams.get('q');
    const olaKey = Deno.env.get('OLA_MAPS_API_KEY');
    if (placeName && olaKey) {
      try {
        const searchParams = new URLSearchParams({
          input: placeName,
          api_key: olaKey,
          location: '12.9716,77.5946', // same fixed Bengaluru center App.tsx uses when no viewer location is known
        });
        const searchResponse = await fetch(`https://api.olamaps.io/places/v1/autocomplete?${searchParams.toString()}`);
        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          const match = bestPlaceMatch(placeName, searchData?.predictions ?? []);
          if (match) {
            return json({ latitude: match.lat, longitude: match.lng });
          }
        }
      } catch {
        // Falls through to returning finalUrl below — the client's own
        // regexes will find nothing in a search URL either, but that's the
        // same "could not read that link" outcome as before this fallback
        // existed, not a new failure mode.
      }
    }
  }

  return json({ finalUrl: resolvedUrl.toString() });
});
