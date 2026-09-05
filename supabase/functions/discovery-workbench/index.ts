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
// Phase 1 scope only: list / get / update. Photo actions (addPhoto,
// addPhotoFromUrl, listPhotos, removePhoto) and batchStatus are a later
// phase, per the approved plan.
//
// Deploy with:
//   npx supabase functions deploy discovery-workbench --project-ref nvingzluboafxzxgxxwc

import { verifyAllowlist, corsHeaders, json } from '../_shared/allowlistAuth.ts';

const ALLOWED_UPDATE_FIELDS = ['phone', 'number_valid', 'menu_list_under_100', 'dishes'] as const;
type AllowedUpdateField = (typeof ALLOWED_UPDATE_FIELDS)[number];

const VALID_NUMBER_VALID = ['Yes', 'No', 'No Answer'];
const VALID_MENU_LIST_UNDER_100 = ['Yes', 'No'];

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

  return json({ error: 'Unknown action' }, 400);
});
