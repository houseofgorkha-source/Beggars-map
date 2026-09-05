// Generalized version of _shared/adminAuth.ts's verifyAdmin, parameterized
// on which comma-separated allowlist env var to check. Extracted so a new
// feature needing its own, narrower allowlist (e.g. DISCOVERY_EMAILS for the
// Discovery Workbench — least-privilege, so an intern's access never
// extends to listings moderation/reports/audit log) doesn't have to either
// duplicate this logic or get folded into ADMIN_EMAILS. adminAuth.ts itself
// is left untouched; nothing about the existing Admin panel changes.
//
// Same security model as adminAuth.ts's own header describes: the
// service-role key never leaves this server-side function, the caller's own
// JWT is verified first (proves who they are), then their email is checked
// against the given allowlist. Anyone else gets 401/403 before any data is
// touched.

import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

// Duplicated from _shared/adminAuth.ts rather than imported — these two are
// truly generic one-liners with no logic to drift, and importing across
// feature boundaries just to save four lines isn't worth the coupling.
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

export type AllowlistAuthResult =
  | { ok: true; email: string; client: SupabaseClient }
  | { ok: false; status: number; error: string };

export async function verifyAllowlist(req: Request, envVarName: string): Promise<AllowlistAuthResult> {
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

  const allowedEmails = (Deno.env.get(envVarName) ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (!allowedEmails.includes(user.email.toLowerCase())) {
    return { ok: false, status: 403, error: 'Not authorized' };
  }

  // Separate client for the actual privileged operations — same split as
  // adminAuth.ts/delete-account (identity check vs. the privileged action
  // itself).
  const client = createClient(supabaseUrl, serviceRoleKey);
  return { ok: true, email: user.email, client };
}
