// Admin-only endpoint for the dashboard view: aggregate listing/report
// counts plus a feed of recent admin activity. Read-only — no action here
// ever mutates data.
//
// Security model: identical to admin-reports/admin-listings — see
// _shared/adminAuth.ts's header for the full rationale.
//
// Deploy with:
//   npx supabase functions deploy admin-dashboard --project-ref nvingzluboafxzxgxxwc

import { corsHeaders, json, verifyAdmin } from '../_shared/adminAuth.ts';
import { getPendingReportGroups } from '../_shared/reportGroups.ts';
import { applyListingFilters, getReviewTrackingBaseline } from '../_shared/listingFilters.ts';

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
  const { adminClient, email: adminEmail } = auth;

  let body: {
    action?: string;
    page?: number;
    pageSize?: number;
    filters?: { actorType?: string; action?: string; targetType?: string; targetId?: string };
    key?: string;
    value?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // Only one setting exists so far — an allow-list of exactly one key,
  // same shape as admin-listings' field allow-list, so a stray/incorrect
  // key can never silently create a new row this UI doesn't know about.
  const ALLOWED_SETTINGS = ['import_default_reviewed'];

  if (body.action === 'getSettings') {
    const { data, error } = await adminClient.from('admin_settings').select('key, value, updated_at, updated_by');
    if (error) return json({ error: error.message }, 500);
    const settings: Record<string, unknown> = {};
    for (const row of data ?? []) settings[row.key] = row.value;
    return json({ data: settings });
  }

  if (body.action === 'updateSetting') {
    if (!body.key || !ALLOWED_SETTINGS.includes(body.key)) {
      return json({ error: `Unknown or disallowed setting key: ${body.key}` }, 400);
    }
    if (typeof body.value !== 'boolean') {
      return json({ error: 'value must be a boolean' }, 400);
    }
    // Settings changes are recorded on the row itself (updated_at/updated_by)
    // rather than admin_audit_log — that table's target_id is a uuid keyed
    // to a listing/report, which a text-keyed setting doesn't fit, and
    // this is a config change, not a moderation action on either of those.
    const { error } = await adminClient
      .from('admin_settings')
      .update({ value: body.value, updated_at: new Date().toISOString(), updated_by: adminEmail })
      .eq('key', body.key);
    if (error) return json({ error: error.message }, 500);
    return json({ success: true });
  }

  if (body.action === 'auditLog') {
    const page = Math.max(1, Number(body.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(body.pageSize) || 20));

    let query = adminClient.from('admin_audit_log').select('*', { count: 'exact' });
    const f = body.filters ?? {};
    if (f.actorType) query = query.eq('actor_type', f.actorType);
    if (f.action) query = query.eq('action', f.action);
    if (f.targetType) query = query.eq('target_type', f.targetType);
    if (f.targetId) query = query.eq('target_id', f.targetId);

    query = query.order('created_at', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) return json({ error: error.message }, 500);
    return json({ data, total: count ?? 0, page, pageSize });
  }

  if (body.action !== 'stats') {
    return json({ error: 'Unknown action' }, 400);
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  let baseline: string;
  try {
    baseline = await getReviewTrackingBaseline(adminClient);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
  // Same predicate `list`/`bulkMarkReviewed` use — reviewed_at IS NULL
  // AND created_at > baseline — never raw reviewed_at IS NULL, so this
  // count never includes pre-existing legacy listings that were simply
  // never reviewed under the old workflow.
  const unreviewedQuery = applyListingFilters(
    adminClient.from('listings').select('id', { count: 'exact', head: true }),
    { reviewed: false },
    baseline
  );

  const [
    totalListings,
    newListings7d,
    newListings30d,
    hiddenListings,
    archivedListings,
    unreviewedListings,
    bySourceRaw,
    reportGroupsResult,
    recentActivity,
  ] = await Promise.all([
    adminClient.from('listings').select('id', { count: 'exact', head: true }),
    adminClient.from('listings').select('id', { count: 'exact', head: true }).gte('created_at', sevenDaysAgo),
    adminClient.from('listings').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo),
    adminClient.from('listings').select('id', { count: 'exact', head: true }).eq('is_hidden', true),
    adminClient.from('listings').select('id', { count: 'exact', head: true }).not('archived_at', 'is', null),
    unreviewedQuery,
    adminClient.from('listings').select('source'),
    getPendingReportGroups(adminClient),
    adminClient.from('admin_audit_log').select('*').order('created_at', { ascending: false }).limit(20),
  ]);

  for (const r of [totalListings, newListings7d, newListings30d, hiddenListings, archivedListings, unreviewedListings, bySourceRaw, recentActivity]) {
    if (r.error) return json({ error: r.error.message }, 500);
  }
  if ('error' in reportGroupsResult) return json({ error: reportGroupsResult.error }, 500);

  const bySource: Record<string, number> = {};
  for (const row of bySourceRaw.data ?? []) {
    const key = (row as { source: string }).source;
    bySource[key] = (bySource[key] ?? 0) + 1;
  }

  return json({
    data: {
      totalListings: totalListings.count ?? 0,
      newListings7d: newListings7d.count ?? 0,
      newListings30d: newListings30d.count ?? 0,
      hiddenListings: hiddenListings.count ?? 0,
      archivedListings: archivedListings.count ?? 0,
      unreviewedListings: unreviewedListings.count ?? 0,
      pendingReportGroups: reportGroupsResult.data.length,
      bySource,
      recentActivity: recentActivity.data ?? [],
    },
  });
});
