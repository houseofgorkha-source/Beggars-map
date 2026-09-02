// Shared listing-mutation actions (hide/unhide/archive/unarchive), used by
// both admin-reports (acting on a listing via a report group) and
// admin-listings (acting on a listing directly). One implementation of
// each mutation + its audit log entry, so the two call sites can never
// drift apart on what "hide" actually does or how it's logged.
//
// Archive/unarchive semantics (approved design): archiving always hides
// too (an archived listing can never remain publicly visible) — one
// atomic update. Unarchiving only clears archived_at; it does NOT restore
// visibility on its own, which requires a separate, explicit unhide.

import { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { writeAuditLog, AuditAction } from './adminAuth.ts';

export type ActionResult = { ok: true } | { ok: false; status: number; error: string };

async function snapshotListing(adminClient: SupabaseClient, listingId: string) {
  const { data } = await adminClient.from('listings').select('*').eq('id', listingId).maybeSingle();
  return data ?? null;
}

async function applyAndLog(
  adminClient: SupabaseClient,
  listingId: string,
  action: AuditAction,
  update: Record<string, unknown>,
  adminEmail: string,
  requestMetadata: unknown
): Promise<ActionResult> {
  const before = await snapshotListing(adminClient, listingId);
  if (!before) {
    return { ok: false, status: 404, error: 'Listing not found' };
  }

  const { error: updateError } = await adminClient.from('listings').update(update).eq('id', listingId);
  if (updateError) {
    return { ok: false, status: 500, error: updateError.message };
  }

  const after = await snapshotListing(adminClient, listingId);

  const audit = await writeAuditLog(adminClient, {
    actor_type: 'admin',
    actor_label: adminEmail,
    action,
    target_type: 'listing',
    target_id: listingId,
    before_state: before,
    after_state: after,
    request_metadata: requestMetadata,
  });
  if (!audit.ok) {
    // The mutation already succeeded — surfacing this as an error is
    // deliberate: a silent audit-log gap is worse than a loud one. The
    // caller is told the underlying data DID change even though this
    // request reports failure, so it isn't retried in a way that could
    // double-apply the mutation.
    return { ok: false, status: 500, error: `Action succeeded but audit logging failed: ${audit.error}` };
  }

  return { ok: true };
}

export function hideListing(adminClient: SupabaseClient, listingId: string, adminEmail: string, requestMetadata: unknown) {
  return applyAndLog(adminClient, listingId, 'hide', { is_hidden: true }, adminEmail, requestMetadata);
}

export function unhideListing(adminClient: SupabaseClient, listingId: string, adminEmail: string, requestMetadata: unknown) {
  return applyAndLog(adminClient, listingId, 'unhide', { is_hidden: false }, adminEmail, requestMetadata);
}

export function archiveListing(adminClient: SupabaseClient, listingId: string, adminEmail: string, requestMetadata: unknown) {
  return applyAndLog(
    adminClient,
    listingId,
    'archive',
    { archived_at: new Date().toISOString(), is_hidden: true },
    adminEmail,
    requestMetadata
  );
}

export function unarchiveListing(adminClient: SupabaseClient, listingId: string, adminEmail: string, requestMetadata: unknown) {
  return applyAndLog(adminClient, listingId, 'unarchive', { archived_at: null }, adminEmail, requestMetadata);
}
