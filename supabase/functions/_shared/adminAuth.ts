// Shared admin identity/authorization check, used by every admin-* Edge
// Function (admin-reports, admin-listings, admin-dashboard). Extracted so
// there is exactly one implementation of "is this caller an admin" — see
// AGENTS.md's own repeated warning about duplicated logic (content
// moderation, bestPlaceMatch, etc.) silently drifting between copies.
//
// Security model, unchanged from the original admin-reports (see its own
// header comment for the full rationale): the service-role key never
// leaves this server-side function. The caller's own JWT is verified
// first (proves who they are), then their email is checked against the
// ADMIN_EMAILS secret. Anyone else gets 401/403 before any admin data is
// touched — this file is the one place that check lives now.
//
// _shared/ is a Supabase CLI convention: files here are never deployed as
// their own function, only imported by sibling functions via a relative
// path (e.g. `import { verifyAdmin } from '../_shared/adminAuth.ts'`).

import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export type AdminAuthResult =
  | { ok: true; email: string; adminClient: SupabaseClient }
  | { ok: false; status: number; error: string };

export async function verifyAdmin(req: Request): Promise<AdminAuthResult> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return { ok: false, status: 401, error: 'Missing Authorization header' };
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
    return { ok: false, status: 401, error: 'Could not verify caller identity' };
  }

  const adminEmails = (Deno.env.get('ADMIN_EMAILS') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (!adminEmails.includes(user.email.toLowerCase())) {
    return { ok: false, status: 403, error: 'Not authorized' };
  }

  // Separate client for the actual privileged operations — same split as
  // delete-account (identity check vs. the privileged action itself).
  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  return { ok: true, email: user.email, adminClient };
}

export function requestMetadata(req: Request): Record<string, unknown> {
  // Best-effort only — Supabase's edge network doesn't guarantee any of
  // these headers are present, and this must never block/fail the actual
  // admin action if they're absent.
  return {
    ip: req.headers.get('x-forwarded-for') ?? null,
    user_agent: req.headers.get('user-agent') ?? null,
  };
}

export type AuditAction =
  | 'create'
  | 'import'
  | 'edit'
  | 'hide'
  | 'unhide'
  | 'archive'
  | 'unarchive'
  | 'resolve_report'
  | 'mark_reviewed'
  | 'mark_unreviewed';

export type AuditEntry = {
  actor_type: 'admin' | 'discovery_pipeline';
  actor_label: string;
  action: AuditAction;
  target_type: 'listing' | 'report';
  target_id: string;
  before_state?: unknown;
  after_state?: unknown;
  request_metadata?: unknown;
};

// Audit rows are immutable at the database level (admin_audit_log_immutable
// trigger, 0013) — this insert is the only kind of write this table will
// ever accept. Never blocks/throws into the caller: a logging failure
// must not silently corrupt the actual admin action's own response, but
// it must also not be swallowed silently — callers should surface
// `ok: false` to the admin so a gap in the audit trail is visible, not
// hidden.
export async function writeAuditLog(
  adminClient: SupabaseClient,
  entry: AuditEntry
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await adminClient.from('admin_audit_log').insert(entry);
  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
