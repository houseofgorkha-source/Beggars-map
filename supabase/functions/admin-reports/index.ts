// Minimal admin-only endpoint for reviewing/resolving reports and toggling
// listings.is_hidden. This is deliberately small — not a moderation
// dashboard, just: list pending report groups, hide/unhide a listing,
// dismiss a report group without deleting the underlying rows.
//
// Security model: the service-role key never leaves this server-side
// function (same pattern as delete-account) — the browser never holds it.
// The caller's own JWT is verified first (proves who they are), then their
// email is checked against the ADMIN_EMAILS secret (comma-separated).
// Anyone else gets 403 before any report/listing data is touched. This
// means reports/listings RLS is never weakened and no new public-facing
// policy is added — this function reads/writes via a service-role client,
// entirely outside RLS, only after the email check passes.
//
// Deploy with:
//   npx supabase functions deploy admin-reports --project-ref nvingzluboafxzxgxxwc
// Also requires the ADMIN_EMAILS secret (comma-separated admin emails):
//   npx supabase secrets set ADMIN_EMAILS=you@example.com --project-ref nvingzluboafxzxgxxwc

import { createClient } from 'npm:@supabase/supabase-js@2';

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

type ReportRow = {
  listing_id: string;
  reason: string;
  reported_by: string;
  created_at: string;
  listings: { name: string; is_hidden: boolean } | null;
};

type ReportGroup = {
  listingId: string;
  name: string;
  reason: string;
  reportCount: number;
  distinctReporterCount: number;
  latest: string;
  isHidden: boolean;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return json({ error: 'Missing Authorization header' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Scoped to the caller's own JWT — used only to find out who they are.
  const callerClient = createClient(supabaseUrl, serviceRoleKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userError,
  } = await callerClient.auth.getUser();

  if (userError || !user?.email) {
    return json({ error: 'Could not verify caller identity' }, 401);
  }

  const adminEmails = (Deno.env.get('ADMIN_EMAILS') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (!adminEmails.includes(user.email.toLowerCase())) {
    return json({ error: 'Not authorized' }, 403);
  }

  let body: { action?: string; listingId?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // Separate client for the actual privileged operations — same split as
  // delete-account (identity check vs. the privileged action itself).
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  if (body.action === 'list') {
    const { data, error } = await adminClient
      .from('reports')
      .select('listing_id, reason, reported_by, created_at, listings(name, is_hidden)')
      .is('resolved_at', null);

    if (error) return json({ error: error.message }, 500);

    // Grouped by (listing, reason) — matches how the admin view presents
    // reports and how "dismiss" resolves them. reported_by is only ever
    // used here to size a Set for the distinct-reporter count; the raw ids
    // are never included in the response, so no reporter identity leaves
    // this function.
    const groups = new Map<
      string,
      { listingId: string; name: string; reason: string; reportCount: number; distinctReporters: Set<string>; latest: string; isHidden: boolean }
    >();
    for (const row of (data as unknown as ReportRow[]) ?? []) {
      if (!row.listings) continue; // listing itself was deleted; nothing actionable left
      const key = `${row.listing_id}::${row.reason}`;
      const g = groups.get(key) ?? {
        listingId: row.listing_id,
        name: row.listings.name,
        reason: row.reason,
        reportCount: 0,
        distinctReporters: new Set<string>(),
        latest: row.created_at,
        isHidden: row.listings.is_hidden,
      };
      g.reportCount += 1;
      g.distinctReporters.add(row.reported_by);
      if (row.created_at > g.latest) g.latest = row.created_at;
      groups.set(key, g);
    }

    const result: ReportGroup[] = Array.from(groups.values())
      .map((g) => ({
        listingId: g.listingId,
        name: g.name,
        reason: g.reason,
        reportCount: g.reportCount,
        distinctReporterCount: g.distinctReporters.size,
        latest: g.latest,
        isHidden: g.isHidden,
      }))
      .sort((a, b) => (a.latest < b.latest ? 1 : -1));

    return json({ data: result });
  }

  if (body.action === 'hide' || body.action === 'unhide') {
    if (!body.listingId) return json({ error: 'Missing listingId' }, 400);
    const { error } = await adminClient
      .from('listings')
      .update({ is_hidden: body.action === 'hide' })
      .eq('id', body.listingId);
    if (error) return json({ error: error.message }, 500);
    return json({ success: true });
  }

  if (body.action === 'resolve') {
    if (!body.listingId || !body.reason) return json({ error: 'Missing listingId/reason' }, 400);
    const { error } = await adminClient
      .from('reports')
      .update({ resolved_at: new Date().toISOString() })
      .eq('listing_id', body.listingId)
      .eq('reason', body.reason)
      .is('resolved_at', null);
    if (error) return json({ error: error.message }, 500);
    return json({ success: true });
  }

  return json({ error: 'Unknown action' }, 400);
});
