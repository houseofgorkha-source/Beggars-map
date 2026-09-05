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

    let response: Response;
    try {
      response = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
    } catch {
      return json({ error: 'Could not fetch that image URL' }, 400);
    }
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

    if (!(await candidateExists(client, body.placeId))) {
      return json({ error: 'Candidate not found in the active batch' }, 404);
    }

    const { error } = await client.storage.from(BUCKET).remove([`${body.placeId}/${filename}`]);
    if (error) return json({ error: error.message }, 500);
    return json({ success: true });
  }

  return json({ error: 'Unknown action' }, 400);
});
