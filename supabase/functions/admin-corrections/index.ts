// Admin-only endpoint for reviewing user-submitted listing corrections
// (name/dishes/location proposals, listing_corrections/0023) and for
// reactively deleting an abusive community review (listing_reviews/0022).
// Deliberately small, mirroring admin-reports' own shape: list the pending
// queue, approve/reject one correction, delete one review. No bulk actions,
// no filters beyond status — if that's ever needed, extend this the same
// way admin-listings grew its own bulk actions over time.
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

  let body: { action?: string; correctionId?: string; reason?: string; status?: string; reviewId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.action === 'list') {
    // Defaults to the pending queue — the thing an admin actually needs to
    // act on. `status: 'all'` (or a specific status) lets the same action
    // double as a lightweight history view without a second endpoint.
    let query = adminClient
      .from('listing_corrections')
      .select(`${CORRECTION_COLUMNS}, listings ( name, dishes, price_rupees, latitude, longitude, location_label )`)
      .order('created_at', { ascending: false });
    const status = body.status ?? 'pending';
    if (status !== 'all') query = query.eq('status', status);

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
    if (!body.reviewId) return json({ error: 'Missing reviewId' }, 400);

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
      request_metadata: meta,
    });
    if (!audit.ok) return json({ error: `Action succeeded but audit logging failed: ${audit.error}` }, 500);

    return json({ success: true });
  }

  return json({ error: 'Unknown action' }, 400);
});
