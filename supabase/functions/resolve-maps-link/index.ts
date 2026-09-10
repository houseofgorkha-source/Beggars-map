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
// only a place name (?q=) and a Knowledge Graph id. There is deliberately no
// fallback for this case: an earlier version approximated a coordinate via
// an OLA Places text search on the extracted place name, but that is a
// GUESS, not the actual location Google's page was showing — it violates
// the location-safety rule this app now holds as absolute (never silently
// guess a restaurant's coordinate). The client's own extraction
// (extractGoogleCoordsFromUrl) finds nothing in a search-results URL either,
// so this now just returns `finalUrl` unconditionally and lets that surface
// as the same explicit "could not read that link" error the client already
// shows for any other unresolvable link — a safe failure, not a wrong guess.
//
// Deploy with:
//   npx supabase functions deploy resolve-maps-link --project-ref nvingzluboafxzxgxxwc

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

  // share.google's redirect target is a Search results page, not Maps —
  // there is no lat/lng in that URL and no attempt is made to guess one
  // (see the header comment). The client's own extractGoogleCoordsFromUrl
  // will find nothing in a search-results URL either and correctly returns
  // null, surfacing as the same "could not read that link" error as any
  // other unresolvable link — a safe failure, not a wrong guess.
  return json({ finalUrl: resolvedUrl.toString() });
});
