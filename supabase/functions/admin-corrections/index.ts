// Admin-only endpoint for reviewing user-submitted listing corrections
// (name/dishes/location proposals, listing_corrections/0023) and for
// moderating community reviews (listing_reviews/0022): list the corrections
// queue (any status, optionally filtered by type), approve/reject one
// correction, list reviews (globally or for one listing), delete one review
// (reason required, folded into the audit row's request_metadata). No bulk
// actions — if that's ever needed, extend this the same way admin-listings
// grew its own bulk actions over time.
//
// Security model: identity/authorization lives in _shared/adminAuth.ts —
// see that file's header for the full rationale (service-role key never
// leaves the server, caller's JWT verified first, then their email is
// checked against ADMIN_EMAILS). This function only ever touches
// correction/review data after that check passes.
//
// Canonical `listings` fields are updated ONLY through the approve action
// below (via applyListingCorrection, service_role) — this is the one path
// lock_listing_admin_fields/lock_listing_location_fields (0016/0015) let
// through; the public client has no other way to move these columns.
//
// Deploy with:
//   npx supabase functions deploy admin-corrections --project-ref nvingzluboafxzxgxxwc
// Requires the same ADMIN_EMAILS secret every other admin-* function does.

import { corsHeaders, json, verifyAdmin, requestMetadata, writeAuditLog } from '../_shared/adminAuth.ts';
import { applyListingCorrection, rejectListingCorrection } from '../_shared/listingActions.ts';

const CORRECTION_COLUMNS =
  'id, listing_id, created_by, correction_type, proposed_name, proposed_dishes, proposed_latitude, proposed_longitude, proposed_location_label, submitter_note, status, reviewed_at, reviewed_by, rejection_reason, created_at';

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
    correctionId?: string;
    reason?: string;
    status?: string;
    correctionType?: string;
    reviewId?: string;
    listingId?: string;
    page?: number;
    pageSize?: number;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.action === 'list') {
    // Defaults to the pending queue — the thing an admin actually needs to
    // act on. `status: 'all'` (or a specific status) lets the same action
    // double as a lightweight history view without a second endpoint.
    // `profiles ( display_name )` — the submitter's identity, joined via
    // the existing created_by -> profiles.id FK — was previously fetched
    // as a raw uuid and never rendered anywhere; this closes that gap at
    // the source rather than requiring a second round-trip client-side.
    let query = adminClient
      .from('listing_corrections')
      .select(
        `${CORRECTION_COLUMNS}, listings ( name, dishes, price_rupees, latitude, longitude, location_label ), profiles ( display_name )`
      )
      .order('created_at', { ascending: false });
    const status = body.status ?? 'pending';
    if (status !== 'all') query = query.eq('status', status);
    if (body.correctionType) query = query.eq('correction_type', body.correctionType);

    const { data, error } = await query;
    if (error) return json({ error: error.message }, 500);
    return json({ data });
  }

  if (body.action === 'approve') {
    if (!body.correctionId) return json({ error: 'Missing correctionId' }, 400);
    const result = await applyListingCorrection(adminClient, body.correctionId, adminEmail, meta);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ success: true });
  }

  if (body.action === 'reject') {
    if (!body.correctionId || !body.reason) return json({ error: 'Missing correctionId/reason' }, 400);
    const result = await rejectListingCorrection(adminClient, body.correctionId, body.reason, adminEmail, meta);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ success: true });
  }

  if (body.action === 'deleteReview') {
    // A reason is required (same posture as reject above) so the audit
    // trail always explains why a piece of community content was removed —
    // folded into request_metadata (already jsonb) rather than a new
    // column, since this is the only action that ever needs it.
    if (!body.reviewId || !body.reason) return json({ error: 'Missing reviewId/reason' }, 400);

    const { data: before, error: fetchError } = await adminClient
      .from('listing_reviews')
      .select('*')
      .eq('id', body.reviewId)
      .maybeSingle();
    if (fetchError) return json({ error: fetchError.message }, 500);
    if (!before) return json({ error: 'Review not found' }, 404);

    // listing_review_photos cascades on delete (0022's own FK), so no
    // separate cleanup step is needed here.
    const { error: deleteError } = await adminClient.from('listing_reviews').delete().eq('id', body.reviewId);
    if (deleteError) return json({ error: deleteError.message }, 500);

    const audit = await writeAuditLog(adminClient, {
      actor_type: 'admin',
      actor_label: adminEmail,
      action: 'delete_review',
      target_type: 'listing_review',
      target_id: body.reviewId,
      before_state: before,
      after_state: null,
      request_metadata: { ...meta, reason: body.reason },
    });
    if (!audit.ok) return json({ error: `Action succeeded but audit logging failed: ${audit.error}` }, 500);

    return json({ success: true });
  }

  if (body.action === 'listReviews') {
    // listingId -> the per-listing case (ListingDetail's own Reviews
    // section), no pagination needed since one listing's review count is
    // always small. No listingId -> the global moderation queue, paginated
    // like every other admin list action. Same implicit-FK-embed
    // convention as `list` above: created_by -> profiles.id,
    // listing_id -> listings.id, and the reverse FK from
    // listing_review_photos.listing_review_id.
    let query = adminClient
      .from('listing_reviews')
      .select(
        'id, listing_id, created_by, rating, review_text, created_at, updated_at, listings ( name ), profiles ( display_name ), listing_review_photos ( id, photo_url, storage_path, position )',
        { count: 'exact' }
      )
      .order('created_at', { ascending: false });

    if (body.listingId) {
      query = query.eq('listing_id', body.listingId);
    } else {
      const page = Math.max(1, Number(body.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(body.pageSize) || 20));
      query = query.range((page - 1) * pageSize, page * pageSize - 1);
    }

    const { data, error, count } = await query;
    if (error) return json({ error: error.message }, 500);
    return json({ data: data ?? [], total: count ?? 0 });
  }

  return json({ error: 'Unknown action' }, 400);
});
