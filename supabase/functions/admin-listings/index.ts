// Admin-only endpoint for browsing, editing, and moderating listings
// directly (independent of any report) — search/filter/sort, full detail
// view (photos + provenance + recent audit history), field edits, and the
// hide/unhide/archive/unarchive moderation actions. No permanent delete —
// that capability is deliberately not part of this pass; hide/archive are
// the only ways to take a listing off the public map.
//
// Security model: identical to admin-reports — see _shared/adminAuth.ts's
// header for the full rationale. Every action requires a verified admin
// email before touching any data.
//
// Deploy with:
//   npx supabase functions deploy admin-listings --project-ref nvingzluboafxzxgxxwc

import { corsHeaders, json, verifyAdmin, requestMetadata, writeAuditLog } from '../_shared/adminAuth.ts';
import { hideListing, unhideListing, archiveListing, unarchiveListing } from '../_shared/listingActions.ts';

const ALLOWED_UPDATE_FIELDS = [
  'name',
  'price_rupees',
  'note',
  'latitude',
  'longitude',
  'location_label',
  'verification_status',
  'evidence_url',
  'evidence_date',
] as const;
type AllowedUpdateField = (typeof ALLOWED_UPDATE_FIELDS)[number];

const VALID_VERIFICATION_STATUSES = ['unverified', 'pending_review', 'human_verified', 'rejected'];
const VALID_SORT_COLUMNS = ['created_at', 'updated_at', 'price_rupees', 'name'];

function escapeSearchTerm(term: string): string {
  // `,` and `(`/`)` have structural meaning in PostgREST's `.or()` filter
  // syntax — strip them rather than let a search term accidentally alter
  // the shape of the filter. `%`/`_` are ILIKE wildcards — escape them so
  // a literal percent sign in a search term is matched literally.
  return term
    .replace(/[,()]/g, ' ')
    .replace(/[%_]/g, '\\$&')
    .trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const auth = await verifyAdmin(req);
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }
  const { email: adminEmail, adminClient } = auth;
  const meta = requestMetadata(req);

  let body: {
    action?: string;
    listingId?: string;
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: string;
    filters?: {
      source?: string;
      verificationStatus?: string;
      isHidden?: boolean;
      archived?: boolean;
      search?: string;
    };
    fields?: Record<string, unknown>;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.action === 'list') {
    const page = Math.max(1, Number(body.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(body.pageSize) || 20));
    const sortBy = VALID_SORT_COLUMNS.includes(body.sortBy ?? '') ? (body.sortBy as string) : 'created_at';
    const sortDir = body.sortDir === 'asc' ? 'asc' : 'desc';

    let query = adminClient.from('listings').select('*', { count: 'exact' });

    const f = body.filters ?? {};
    if (f.source) query = query.eq('source', f.source);
    if (f.verificationStatus) query = query.eq('verification_status', f.verificationStatus);
    if (typeof f.isHidden === 'boolean') query = query.eq('is_hidden', f.isHidden);
    if (typeof f.archived === 'boolean') {
      query = f.archived ? query.not('archived_at', 'is', null) : query.is('archived_at', null);
    }
    if (f.search && f.search.trim()) {
      const esc = escapeSearchTerm(f.search);
      if (esc) query = query.or(`name.ilike.%${esc}%,note.ilike.%${esc}%,location_label.ilike.%${esc}%`);
    }

    query = query.order(sortBy, { ascending: sortDir === 'asc' }).range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) return json({ error: error.message }, 500);

    return json({ data, total: count ?? 0, page, pageSize });
  }

  if (body.action === 'get') {
    if (!body.listingId) return json({ error: 'Missing listingId' }, 400);

    const { data: listing, error: listingError } = await adminClient
      .from('listings')
      .select('*')
      .eq('id', body.listingId)
      .maybeSingle();
    if (listingError) return json({ error: listingError.message }, 500);
    if (!listing) return json({ error: 'Listing not found' }, 404);

    const { data: photos, error: photosError } = await adminClient
      .from('listing_photos')
      .select('*')
      .eq('listing_id', body.listingId)
      .order('position', { ascending: true });
    if (photosError) return json({ error: photosError.message }, 500);

    const { data: auditHistory, error: auditError } = await adminClient
      .from('admin_audit_log')
      .select('*')
      .eq('target_type', 'listing')
      .eq('target_id', body.listingId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (auditError) return json({ error: auditError.message }, 500);

    return json({ data: { listing, photos: photos ?? [], auditHistory: auditHistory ?? [] } });
  }

  if (body.action === 'update') {
    if (!body.listingId) return json({ error: 'Missing listingId' }, 400);
    if (!body.fields || typeof body.fields !== 'object') return json({ error: 'Missing fields' }, 400);

    const rejectedKeys = Object.keys(body.fields).filter((k) => !ALLOWED_UPDATE_FIELDS.includes(k as AllowedUpdateField));
    if (rejectedKeys.length > 0) {
      return json({ error: `These fields cannot be edited via this action: ${rejectedKeys.join(', ')}` }, 400);
    }
    if (Object.keys(body.fields).length === 0) {
      return json({ error: 'No fields to update' }, 400);
    }
    if (
      'verification_status' in body.fields &&
      !VALID_VERIFICATION_STATUSES.includes(body.fields.verification_status as string)
    ) {
      return json({ error: 'Invalid verification_status' }, 400);
    }

    const { data: before, error: beforeError } = await adminClient
      .from('listings')
      .select('*')
      .eq('id', body.listingId)
      .maybeSingle();
    if (beforeError) return json({ error: beforeError.message }, 500);
    if (!before) return json({ error: 'Listing not found' }, 404);

    const update = { ...body.fields, last_modified_by: adminEmail };
    const { error: updateError } = await adminClient.from('listings').update(update).eq('id', body.listingId);
    if (updateError) return json({ error: updateError.message }, 400);

    const { data: after } = await adminClient.from('listings').select('*').eq('id', body.listingId).maybeSingle();

    const audit = await writeAuditLog(adminClient, {
      actor_type: 'admin',
      actor_label: adminEmail,
      action: 'edit',
      target_type: 'listing',
      target_id: body.listingId,
      before_state: before,
      after_state: after,
      request_metadata: meta,
    });
    if (!audit.ok) {
      return json({ error: `Action succeeded but audit logging failed: ${audit.error}` }, 500);
    }

    return json({ success: true, data: after });
  }

  if (['hide', 'unhide', 'archive', 'unarchive'].includes(body.action ?? '')) {
    if (!body.listingId) return json({ error: 'Missing listingId' }, 400);
    const fn = { hide: hideListing, unhide: unhideListing, archive: archiveListing, unarchive: unarchiveListing }[
      body.action as string
    ]!;
    const result = await fn(adminClient, body.listingId, adminEmail, meta);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ success: true });
  }

  return json({ error: 'Unknown action' }, 400);
});
