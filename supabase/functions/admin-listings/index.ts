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
import {
  hideListing,
  unhideListing,
  archiveListing,
  unarchiveListing,
  markListingReviewed,
  markListingUnreviewed,
} from '../_shared/listingActions.ts';
import { applyListingFilters, ListingFilters } from '../_shared/listingFilters.ts';

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
    filters?: ListingFilters;
    listingIds?: string[];
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

    let query = applyListingFilters(adminClient.from('listings').select('*', { count: 'exact' }), body.filters ?? {});
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

  if (['hide', 'unhide', 'archive', 'unarchive', 'markReviewed', 'markUnreviewed'].includes(body.action ?? '')) {
    if (!body.listingId) return json({ error: 'Missing listingId' }, 400);
    const fn = {
      hide: hideListing,
      unhide: unhideListing,
      archive: archiveListing,
      unarchive: unarchiveListing,
      markReviewed: markListingReviewed,
      markUnreviewed: markListingUnreviewed,
    }[body.action as string]!;
    const result = await fn(adminClient, body.listingId, adminEmail, meta);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ success: true });
  }

  if (body.action === 'bulkMarkReviewed') {
    // Two mutually exclusive modes:
    //  - listingIds: an explicit set (the "selected" checkboxes case).
    //  - filters: re-applied server-side against the FULL matching set,
    //    ignoring pagination entirely — {} means "every listing". This is
    //    what makes "mark all filtered" / "mark all new" correct even
    //    when the result spans more pages than are currently rendered.
    // Either way, only rows that are CURRENTLY unreviewed are touched and
    // audited — re-marking an already-reviewed listing is a silent no-op,
    // not a second audit entry, so clicking a bulk action twice is safe.
    let query = adminClient.from('listings').select('id').is('reviewed_at', null);
    if (Array.isArray(body.listingIds)) {
      if (body.listingIds.length === 0) return json({ error: 'listingIds is empty' }, 400);
      query = query.in('id', body.listingIds);
    } else {
      query = applyListingFilters(query, body.filters ?? {});
    }

    const { data: targets, error: targetsError } = await query;
    if (targetsError) return json({ error: targetsError.message }, 500);

    let updatedCount = 0;
    for (const row of targets ?? []) {
      const result = await markListingReviewed(adminClient, row.id, adminEmail, meta);
      if (!result.ok) return json({ error: `Failed partway through (${updatedCount} succeeded): ${result.error}` }, result.status);
      updatedCount += 1;
    }

    return json({ success: true, updatedCount });
  }

  return json({ error: 'Unknown action' }, 400);
});
