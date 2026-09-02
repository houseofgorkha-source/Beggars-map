// Admin-only endpoint for reviewing/resolving reports and toggling
// listings.is_hidden. This is deliberately small — not a moderation
// dashboard, just: list pending report groups, hide/unhide a listing,
// dismiss a report group without deleting the underlying rows.
//
// Security model: identity/authorization lives in _shared/adminAuth.ts —
// see that file's header for the full rationale (service-role key never
// leaves the server, caller's JWT verified first, then their email is
// checked against ADMIN_EMAILS). This function only ever touches
// report/listing data after that check passes.
//
// Deploy with:
//   npx supabase functions deploy admin-reports --project-ref nvingzluboafxzxgxxwc
// Also requires the ADMIN_EMAILS secret (comma-separated admin emails):
//   npx supabase secrets set ADMIN_EMAILS=you@example.com --project-ref nvingzluboafxzxgxxwc

import { corsHeaders, json, verifyAdmin, requestMetadata, writeAuditLog } from '../_shared/adminAuth.ts';
import { getPendingReportGroups } from '../_shared/reportGroups.ts';
import { hideListing, unhideListing } from '../_shared/listingActions.ts';

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

  let body: { action?: string; listingId?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.action === 'list') {
    const result = await getPendingReportGroups(adminClient);
    if ('error' in result) return json({ error: result.error }, 500);
    return json({ data: result.data });
  }

  if (body.action === 'hide' || body.action === 'unhide') {
    if (!body.listingId) return json({ error: 'Missing listingId' }, 400);
    const result =
      body.action === 'hide'
        ? await hideListing(adminClient, body.listingId, adminEmail, meta)
        : await unhideListing(adminClient, body.listingId, adminEmail, meta);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ success: true });
  }

  if (body.action === 'resolve') {
    if (!body.listingId || !body.reason) return json({ error: 'Missing listingId/reason' }, 400);

    // Snapshot the exact report rows this resolve will affect, for the
    // audit trail's before/after state — resolution is inherently
    // group-level (listing_id + reason), not a single report row, so
    // there's no single report id to key the audit entry on; the
    // listing_id is the one stable id available for a report group.
    const { data: beforeRows, error: beforeError } = await adminClient
      .from('reports')
      .select('id, reason, created_at, resolved_at')
      .eq('listing_id', body.listingId)
      .eq('reason', body.reason)
      .is('resolved_at', null);
    if (beforeError) return json({ error: beforeError.message }, 500);
    if (!beforeRows || beforeRows.length === 0) {
      return json({ error: 'No matching unresolved reports found' }, 404);
    }

    const resolvedAt = new Date().toISOString();
    const { error } = await adminClient
      .from('reports')
      .update({ resolved_at: resolvedAt, resolved_by: adminEmail })
      .eq('listing_id', body.listingId)
      .eq('reason', body.reason)
      .is('resolved_at', null);
    if (error) return json({ error: error.message }, 500);

    const audit = await writeAuditLog(adminClient, {
      actor_type: 'admin',
      actor_label: adminEmail,
      action: 'resolve_report',
      target_type: 'report',
      target_id: body.listingId,
      before_state: { reason: body.reason, affected_report_ids: beforeRows.map((r) => r.id), resolved_at: null },
      after_state: { reason: body.reason, affected_report_ids: beforeRows.map((r) => r.id), resolved_at: resolvedAt, resolved_by: adminEmail },
      request_metadata: meta,
    });
    if (!audit.ok) {
      return json({ error: `Action succeeded but audit logging failed: ${audit.error}` }, 500);
    }

    return json({ success: true });
  }

  return json({ error: 'Unknown action' }, 400);
});
