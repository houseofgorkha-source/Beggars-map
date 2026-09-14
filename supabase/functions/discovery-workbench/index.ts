// Discovery Workbench — lets an allowlisted intern review one transient
// batch of discovery candidates (see migration 0021's own header for the
// full "why a new table, why private/no-grant" rationale). This function
// only ever operates on public.discovery_batch_rows / the discovery-photos
// bucket — it never touches listings, listing_photos, or any other
// production table.
//
// Security model: identical shape to admin-listings, but checks the
// DISCOVERY_EMAILS allowlist (via the generalized _shared/allowlistAuth.ts)
// instead of ADMIN_EMAILS — an intern's access never extends to listings
// moderation, reports, or the audit log.
//
// Phase 3 adds the photo actions (createPhotoUploadUrl, listPhotos,
// addPhotoFromUrl, removePhoto) this function's Phase 1 header used to flag
// as deferred. list/get/update are unchanged from Phase 1.
//
// Deploy with:
//   npx supabase functions deploy discovery-workbench --project-ref nvingzluboafxzxgxxwc

import { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { verifyAllowlist, corsHeaders, json } from '../_shared/allowlistAuth.ts';

const ALLOWED_UPDATE_FIELDS = ['phone', 'number_valid', 'menu_list_under_100', 'dishes'] as const;
type AllowedUpdateField = (typeof ALLOWED_UPDATE_FIELDS)[number];

const VALID_NUMBER_VALID = ['Yes', 'No', 'No Answer'];
const VALID_MENU_LIST_UNDER_100 = ['Yes', 'No'];

// Photos — final limits per the approved Phase 3 spec: 2 photos/candidate,
// jpeg/png/webp, 2MB each. The private discovery-photos bucket (0021) also
// enforces the mime/size limits at the Storage layer itself, so these
// server-side checks are an early, friendlier rejection, not the only guard.
const BUCKET = 'discovery-photos';
const MAX_PHOTOS = 2;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const EXTENSION_FROM_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

function extensionFromFilename(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx + 1).toLowerCase();
}

// ---- SSRF guard for addPhotoFromUrl ----
// addPhotoFromUrl fetches an intern-supplied URL server-side. Without this,
// a DISCOVERY_EMAILS-allowlisted account (lower trust than a full admin,
// by design) could point this function at an internal/cloud-metadata
// address and use response differences (timeout vs. refused vs. a stored,
// signed-URL-retrievable image) as a working SSRF/probe primitive. This
// guard runs AFTER the existing verifyAllowlist() check — it narrows what
// an already-authorized intern's own action can reach, it does not touch
// or weaken who is authorized to call this function at all.
//
// Two layers: (1) the URL's own hostname, checked directly if it's already
// an IP literal; (2) for a real hostname, every address DNS resolution
// returns for it (both A and AAAA, not just the first answer) — a hostname
// that looks public but resolves to a private address (DNS rebinding) is
// rejected the same way a direct private-IP URL is. Redirects are never
// followed automatically (`redirect: 'manual'`) — each hop's destination is
// re-validated through this same check before being followed, capped at
// MAX_REDIRECTS hops.

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24 (reserved/test)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (test)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (test)
  if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  if (norm === '::1' || norm === '::') return true; // loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/.test(norm)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(norm)) return true; // fc00::/7 unique local (private)
  if (norm.startsWith('ff')) return true; // ff00::/8 multicast
  const mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped — check the embedded address
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateIPLiteral(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host; // strip [::1]-style brackets
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) return isPrivateIPv4(bare);
  if (bare.includes(':')) return isPrivateIPv6(bare);
  return false;
}

async function isPubliclyRoutableUrl(rawUrl: string): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http/https URLs are allowed' };
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { ok: false, reason: 'localhost is not allowed' };
  }
  if (isPrivateIPLiteral(hostname)) {
    return { ok: false, reason: 'Private/internal address is not allowed' };
  }

  let addresses: string[] = [];
  try {
    const [v4, v6] = await Promise.allSettled([Deno.resolveDns(hostname, 'A'), Deno.resolveDns(hostname, 'AAAA')]);
    if (v4.status === 'fulfilled') addresses.push(...v4.value);
    if (v6.status === 'fulfilled') addresses.push(...v6.value);
  } catch {
    // fall through — empty addresses is rejected below either way.
  }
  if (addresses.length === 0) {
    return { ok: false, reason: 'Could not resolve that host' };
  }
  if (addresses.some((ip) => isPrivateIPLiteral(ip))) {
    return { ok: false, reason: 'That host resolves to a private/internal address' };
  }
  return { ok: true, url };
}

const MAX_REDIRECTS = 3;

async function fetchImageSafely(startUrl: string): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
  let currentUrl = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await isPubliclyRoutableUrl(currentUrl);
    if (!check.ok) return { ok: false, error: check.reason };

    let response: Response;
    try {
      response = await fetch(check.url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    } catch {
      return { ok: false, error: 'Could not fetch that image URL' };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { ok: false, error: `Could not fetch that image URL (${response.status})` };
      if (hop === MAX_REDIRECTS) return { ok: false, error: 'Too many redirects' };
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return { ok: true, response };
  }
  return { ok: false, error: 'Too many redirects' };
}

// Every photo action must first confirm placeId belongs to the currently
// active batch — an intern's browser must never be able to read/write
// photos for a candidate that isn't in front of them, even by guessing a
// place_id from a real Google Maps link.
async function candidateExists(client: SupabaseClient, placeId: string): Promise<boolean> {
  const { data } = await client.from('discovery_batch_rows').select('place_id').eq('place_id', placeId).maybeSingle();
  return !!data;
}

async function countPhotos(client: SupabaseClient, placeId: string): Promise<number> {
  const { data } = await client.storage.from(BUCKET).list(`${placeId}/`);
  return data?.length ?? 0;
}

// A signed URL from createSignedUploadUrl()/createSignedUrl() is built from
// this function's own SUPABASE_URL env var — which, only in local dev, is
// the internal Docker network address (confirmed directly: `http://kong:8000`
// inside the local edge runtime container), not an address a browser can
// resolve. Rewriting using the incoming request's own URL doesn't work
// either — confirmed directly that req.url's origin inside the container is
// a THIRD address (Kong's own internal proxy target, e.g.
// `http://127.0.0.1:8081`), not the externally-reachable one the browser
// actually used to reach Kong. The reliable fix is an explicit env var:
// PUBLIC_SUPABASE_URL, set only for local dev (supabase/functions/.env) to
// the address a local browser can actually reach (http://127.0.0.1:54321).
// In production this var is intentionally left unset, so this falls back to
// SUPABASE_URL — already the correct public HTTPS URL there, making the
// rewrite a no-op in that environment.
function toPublicUrl(internalUrl: string): string {
  const publicBase = Deno.env.get('PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL')!;
  const internal = new URL(internalUrl);
  const publicOrigin = new URL(publicBase).origin;
  return `${publicOrigin}${internal.pathname}${internal.search}`;
}

type DishEntry = { dish: string; price: number };

// Mirrors web/src/lib/dishes.ts's formatDishes() exactly ("Masala Dosa ₹60,
// Rice Meals ₹80") — duplicated rather than imported, since Edge Functions
// bundle independently and can't reach across into web/src/. Same accepted
// duplication convention this repo already uses for content moderation and
// bestPlaceMatch (see AGENTS.md's own notes on those).
function formatDishes(entries: DishEntry[]): string {
  return entries.map((entry) => `${entry.dish} ₹${entry.price}`).join(', ');
}

function isValidDishEntry(value: unknown): value is DishEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as { dish?: unknown; price?: unknown };
  if (typeof entry.dish !== 'string' || entry.dish.trim().length === 0) return false;
  if (typeof entry.price !== 'number' || !Number.isInteger(entry.price)) return false;
  return entry.price >= 30 && entry.price <= 100;
}

function isValidDishesArray(value: unknown): value is DishEntry[] {
  return Array.isArray(value) && value.length > 0 && value.every(isValidDishEntry);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const auth = await verifyAllowlist(req, 'DISCOVERY_EMAILS');
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }
  const { client } = auth;

  let body: {
    action?: string;
    placeId?: string;
    fields?: Record<string, unknown>;
    filename?: string;
    imageUrl?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.action === 'list') {
    // This table only ever holds one active batch's worth of rows at a
    // time (workbench-sync.mjs purges the previous batch before pushing a
    // new one), so "list" is simply every row currently present.
    const { data, error } = await client.from('discovery_batch_rows').select('*').order('name', { ascending: true });
    if (error) return json({ error: error.message }, 500);
    return json({ data: data ?? [] });
  }

  if (body.action === 'get') {
    if (!body.placeId) return json({ error: 'Missing placeId' }, 400);
    const { data, error } = await client
      .from('discovery_batch_rows')
      .select('*')
      .eq('place_id', body.placeId)
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: 'Candidate not found in the active batch' }, 404);
    return json({ data });
  }

  if (body.action === 'update') {
    if (!body.placeId) return json({ error: 'Missing placeId' }, 400);
    if (!body.fields || typeof body.fields !== 'object') return json({ error: 'Missing fields' }, 400);

    const rejectedKeys = Object.keys(body.fields).filter((k) => !ALLOWED_UPDATE_FIELDS.includes(k as AllowedUpdateField));
    if (rejectedKeys.length > 0) {
      return json({ error: `These fields cannot be edited via this action: ${rejectedKeys.join(', ')}` }, 400);
    }
    if (Object.keys(body.fields).length === 0) {
      return json({ error: 'No fields to update' }, 400);
    }
    if ('number_valid' in body.fields && body.fields.number_valid !== null && !VALID_NUMBER_VALID.includes(body.fields.number_valid as string)) {
      return json({ error: 'Invalid number_valid' }, 400);
    }
    if (
      'menu_list_under_100' in body.fields &&
      body.fields.menu_list_under_100 !== null &&
      !VALID_MENU_LIST_UNDER_100.includes(body.fields.menu_list_under_100 as string)
    ) {
      return json({ error: 'Invalid menu_list_under_100' }, 400);
    }
    if ('dishes' in body.fields && body.fields.dishes !== null && !isValidDishesArray(body.fields.dishes)) {
      return json({ error: 'dishes must be a non-empty array of {dish, price} with price between ₹30 and ₹100' }, 400);
    }

    const update: Record<string, unknown> = { ...body.fields, updated_at: new Date().toISOString() };
    // notes is always derived server-side from dishes, never free-typed by
    // the intern — see migration 0021's own header and the plan's Section
    // J for the open question about a free-text fallback.
    if ('dishes' in body.fields) {
      update.notes = isValidDishesArray(body.fields.dishes) ? formatDishes(body.fields.dishes) : null;
    }

    const { data, error } = await client
      .from('discovery_batch_rows')
      .update(update)
      .eq('place_id', body.placeId)
      .select('*')
      .maybeSingle();
    if (error) return json({ error: error.message }, 400);
    if (!data) return json({ error: 'Candidate not found in the active batch' }, 404);

    return json({ success: true, data });
  }

  if (body.action === 'createPhotoUploadUrl') {
    if (!body.placeId) return json({ error: 'Missing placeId' }, 400);
    const filename = body.filename;
    if (!filename || typeof filename !== 'string') return json({ error: 'Missing filename' }, 400);

    if (!(await candidateExists(client, body.placeId))) {
      return json({ error: 'Candidate not found in the active batch' }, 404);
    }
    if ((await countPhotos(client, body.placeId)) >= MAX_PHOTOS) {
      return json({ error: `Maximum ${MAX_PHOTOS} photos per candidate` }, 400);
    }
    const ext = extensionFromFilename(filename);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return json({ error: 'Only JPEG, PNG, or WebP images are allowed' }, 400);
    }

    // Fresh, collision-proof filename — never reuses an existing pushed
    // photo's original name, matching AddListingModal.tsx's own convention.
    const path = `${body.placeId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext === 'jpeg' ? 'jpg' : ext}`;
    const { data, error } = await client.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return json({ error: error.message }, 500);
    return json({ data: { path, signedUrl: toPublicUrl(data.signedUrl), token: data.token } });
  }

  if (body.action === 'listPhotos') {
    if (!body.placeId) return json({ error: 'Missing placeId' }, 400);
    if (!(await candidateExists(client, body.placeId))) {
      return json({ error: 'Candidate not found in the active batch' }, 404);
    }

    const { data: objects, error } = await client.storage.from(BUCKET).list(`${body.placeId}/`);
    if (error) return json({ error: error.message }, 500);

    const photos: { name: string; url: string }[] = [];
    for (const obj of objects ?? []) {
      const { data: signed, error: signError } = await client.storage
        .from(BUCKET)
        .createSignedUrl(`${body.placeId}/${obj.name}`, 300);
      // Best-effort per photo: a single bad signed-URL mint must not fail
      // the whole list, since the intern would then see no photos at all
      // for an otherwise-fine candidate.
      if (signError || !signed) continue;
      photos.push({ name: obj.name, url: toPublicUrl(signed.signedUrl) });
    }
    return json({ data: photos });
  }

  if (body.action === 'addPhotoFromUrl') {
    if (!body.placeId) return json({ error: 'Missing placeId' }, 400);
    const imageUrl = body.imageUrl;
    if (!imageUrl || typeof imageUrl !== 'string') return json({ error: 'Missing imageUrl' }, 400);

    if (!(await candidateExists(client, body.placeId))) {
      return json({ error: 'Candidate not found in the active batch' }, 404);
    }
    if ((await countPhotos(client, body.placeId)) >= MAX_PHOTOS) {
      return json({ error: `Maximum ${MAX_PHOTOS} photos per candidate` }, 400);
    }

    const fetchResult = await fetchImageSafely(imageUrl);
    if (!fetchResult.ok) return json({ error: fetchResult.error }, 400);
    const response = fetchResult.response;
    if (!response.ok) return json({ error: `Could not fetch that image URL (${response.status})` }, 400);

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const ext = EXTENSION_FROM_MIME[contentType];
    if (!ext) return json({ error: 'Only JPEG, PNG, or WebP images are allowed' }, 400);

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_PHOTO_BYTES) return json({ error: 'Image is larger than 2MB' }, 400);
    if (bytes.length === 0) return json({ error: 'That URL returned an empty file' }, 400);

    const path = `${body.placeId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const { error: uploadError } = await client.storage.from(BUCKET).upload(path, bytes, { contentType });
    if (uploadError) return json({ error: uploadError.message }, 500);

    const { data: signed } = await client.storage.from(BUCKET).createSignedUrl(path, 300);
    return json({ success: true, data: { name: path.split('/').pop(), url: signed ? toPublicUrl(signed.signedUrl) : null } });
  }

  if (body.action === 'removePhoto') {
    if (!body.placeId) return json({ error: 'Missing placeId' }, 400);
    const filename = body.filename;
    if (!filename || typeof filename !== 'string') return json({ error: 'Missing filename' }, 400);
    // Every filename this function itself ever generates (createPhotoUploadUrl,
    // addPhotoFromUrl) matches this exact shape — reject anything else
    // outright rather than passing a client-supplied string straight into a
    // storage path (defense-in-depth; Storage's own opaque-key model means
    // this was never an actual traversal risk, but an explicit allowlist is
    // cheap and self-documenting).
    if (!/^[0-9]+-[0-9a-f]{8}\.(jpg|jpeg|png|webp)$/.test(filename)) {
      return json({ error: 'Invalid filename' }, 400);
    }

    if (!(await candidateExists(client, body.placeId))) {
      return json({ error: 'Candidate not found in the active batch' }, 404);
    }

    const { error } = await client.storage.from(BUCKET).remove([`${body.placeId}/${filename}`]);
    if (error) return json({ error: error.message }, 500);
    return json({ success: true });
  }

  return json({ error: 'Unknown action' }, 400);
});
