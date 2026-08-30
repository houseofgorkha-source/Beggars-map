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

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// OLA's own ranking for a bare text query weighs proximity more than exact
// name match — verified against a real share.google link ("Dhal roti &
// more") where the actual place came back 2nd, not 1st, so blindly taking
// predictions[0] silently returns the wrong business. This instead scores
// every candidate by how closely its name matches the query text (a sliding
// window the length of the query, minimum edit distance over all
// positions — so a candidate with extra trailing text, e.g. a category
// suffix, isn't unfairly penalized for length) and picks the best match,
// only if it clears a minimum similarity bar.
const MIN_MATCH_RATIO = 0.4;

function bestPlaceMatch(query: string, predictions: any[]): { lat: number; lng: number } | null {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return null;

  let best: { lat: number; lng: number; ratio: number } | null = null;
  for (const p of predictions) {
    const lat = p?.geometry?.location?.lat;
    const lng = p?.geometry?.location?.lng;
    const name = p?.structured_formatting?.main_text ?? p?.description ?? '';
    if (typeof lat !== 'number' || typeof lng !== 'number' || !name) continue;

    const candidate = normalize(name);
    let distance: number;
    if (candidate.length <= normalizedQuery.length) {
      distance = levenshtein(normalizedQuery, candidate);
    } else {
      distance = Infinity;
      for (let i = 0; i <= candidate.length - normalizedQuery.length; i++) {
        distance = Math.min(distance, levenshtein(normalizedQuery, candidate.slice(i, i + normalizedQuery.length)));
      }
    }
    const ratio = 1 - distance / normalizedQuery.length;
    if (!best || ratio > best.ratio) best = { lat, lng, ratio };
  }

  return best && best.ratio >= MIN_MATCH_RATIO ? { lat: best.lat, lng: best.lng } : null;
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
