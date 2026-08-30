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

  try {
    const response = await fetch(parsed.toString());
    return json({ finalUrl: response.url || parsed.toString() });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Failed to resolve link' }, 502);
  }
});
