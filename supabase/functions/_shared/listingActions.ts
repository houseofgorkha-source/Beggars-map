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
import { computeLocationProvenanceOnMove } from './locationProvenance.ts';

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

export function markListingReviewed(adminClient: SupabaseClient, listingId: string, adminEmail: string, requestMetadata: unknown) {
  return applyAndLog(
    adminClient,
    listingId,
    'mark_reviewed',
    { reviewed_at: new Date().toISOString(), reviewed_by: adminEmail },
    adminEmail,
    requestMetadata
  );
}

export function markListingUnreviewed(adminClient: SupabaseClient, listingId: string, adminEmail: string, requestMetadata: unknown) {
  return applyAndLog(adminClient, listingId, 'mark_unreviewed', { reviewed_at: null, reviewed_by: null }, adminEmail, requestMetadata);
}

// ---------------------------------------------------------------------
// Listing corrections (0023) — a user-proposed name/dishes/location change,
// staged in listing_corrections, that only ever reaches `listings` through
// this one approval path (service_role — the only caller
// lock_listing_admin_fields/lock_listing_location_fields ever let through).
// Kept in this file rather than a new one: it's the same "mutate listings +
// write one audit entry" shape hideListing/markListingReviewed/etc. already
// establish, just sourced from a staged proposal instead of a direct field
// list.
// ---------------------------------------------------------------------

type PendingCorrection = {
  id: string;
  listing_id: string;
  status: string;
  correction_type: string;
  proposed_name: string | null;
  proposed_dishes: { dish: string; price: number }[] | null;
  proposed_latitude: number | null;
  proposed_longitude: number | null;
  proposed_location_label: string | null;
};

async function loadPendingCorrection(adminClient: SupabaseClient, correctionId: string): Promise<{ row: PendingCorrection } | { error: ActionResult }> {
  const { data, error } = await adminClient.from('listing_corrections').select('*').eq('id', correctionId).maybeSingle();
  if (error) return { error: { ok: false, status: 500, error: error.message } };
  if (!data) return { error: { ok: false, status: 404, error: 'Correction not found' } };
  if (data.status !== 'pending') {
    return { error: { ok: false, status: 409, error: `This correction was already ${data.status}, not pending` } };
  }
  return { row: data as PendingCorrection };
}

// Builds the exact `listings` update a correction implies — the one place
// "what does approving a name/dishes/location correction actually change"
// is decided. Returns null when the row doesn't actually carry the data its
// own correction_type requires (should never happen for a row this
// component itself created, but the staged row is untrusted input from the
// Edge Function's point of view, so this is checked rather than assumed).
function buildListingUpdateForCorrection(row: PendingCorrection, adminEmail: string, nowIso: string): Record<string, unknown> | null {
  if (row.correction_type === 'name') {
    if (!row.proposed_name) return null;
    return { name: row.proposed_name };
  }
  if (row.correction_type === 'dishes') {
    if (!row.proposed_dishes || row.proposed_dishes.length === 0) return null;
    // Same MIN(dish price) derivation as web/src/lib/dishes.ts's
    // minDishPrice — a plain reduce, not worth importing/duplicating the
    // whole module for one line in Deno.
    const priceRupees = row.proposed_dishes.reduce((lowest, d) => (d.price < lowest ? d.price : lowest), row.proposed_dishes[0].price);
    return { dishes: row.proposed_dishes, price_rupees: priceRupees };
  }
  if (row.correction_type === 'location') {
    if (row.proposed_latitude == null || row.proposed_longitude == null) return null;
    const base: Record<string, unknown> = {
      latitude: row.proposed_latitude,
      longitude: row.proposed_longitude,
      location_label: row.proposed_location_label,
    };
    // Reuses the exact same provenance-default convention an admin moving a
    // pin directly already gets (0015/_shared/locationProvenance.ts) — an
    // admin approving a user-proposed location IS the human confirmation
    // event, same as an admin dragging the pin themselves.
    return { ...base, ...computeLocationProvenanceOnMove(base, adminEmail, nowIso) };
  }
  return null;
}

export async function applyListingCorrection(
  adminClient: SupabaseClient,
  correctionId: string,
  adminEmail: string,
  requestMetadata: unknown
): Promise<ActionResult> {
  const loaded = await loadPendingCorrection(adminClient, correctionId);
  if ('error' in loaded) return loaded.error;
  const correction = loaded.row;

  const nowIso = new Date().toISOString();
  const listingUpdate = buildListingUpdateForCorrection(correction, adminEmail, nowIso);
  if (!listingUpdate) {
    return { ok: false, status: 400, error: `Correction is missing the data required for a "${correction.correction_type}" approval` };
  }

  const before = await snapshotListing(adminClient, correction.listing_id);
  if (!before) return { ok: false, status: 404, error: 'Listing not found' };

  const { error: updateError } = await adminClient.from('listings').update(listingUpdate).eq('id', correction.listing_id);
  if (updateError) return { ok: false, status: 500, error: updateError.message };

  const after = await snapshotListing(adminClient, correction.listing_id);

  const { error: correctionError } = await adminClient
    .from('listing_corrections')
    .update({ status: 'approved', reviewed_at: nowIso, reviewed_by: adminEmail })
    .eq('id', correction.id);
  if (correctionError) {
    // The listing itself already changed — surface this distinctly rather
    // than implying the whole approval failed, same "loud, not silent" gap
    // reasoning applyAndLog's own audit-failure branch already uses.
    return { ok: false, status: 500, error: `Listing was updated but the correction's own status update failed: ${correctionError.message}` };
  }

  const audit = await writeAuditLog(adminClient, {
    actor_type: 'admin',
    actor_label: adminEmail,
    action: 'approve_correction',
    target_type: 'listing_correction',
    target_id: correction.id,
    before_state: before,
    after_state: after,
    request_metadata: requestMetadata,
  });
  if (!audit.ok) {
    return { ok: false, status: 500, error: `Action succeeded but audit logging failed: ${audit.error}` };
  }

  return { ok: true };
}

export async function rejectListingCorrection(
  adminClient: SupabaseClient,
  correctionId: string,
  rejectionReason: string,
  adminEmail: string,
  requestMetadata: unknown
): Promise<ActionResult> {
  const loaded = await loadPendingCorrection(adminClient, correctionId);
  if ('error' in loaded) return loaded.error;
  const before = loaded.row;

  const nowIso = new Date().toISOString();
  const { error } = await adminClient
    .from('listing_corrections')
    .update({ status: 'rejected', reviewed_at: nowIso, reviewed_by: adminEmail, rejection_reason: rejectionReason })
    .eq('id', correctionId);
  if (error) return { ok: false, status: 500, error: error.message };

  // No `listings` mutation happens on reject, so there's nothing to
  // snapshot there — the before/after diff is the correction row's own
  // status transition instead.
  const audit = await writeAuditLog(adminClient, {
    actor_type: 'admin',
    actor_label: adminEmail,
    action: 'reject_correction',
    target_type: 'listing_correction',
    target_id: correctionId,
    before_state: before,
    after_state: { ...before, status: 'rejected', reviewed_at: nowIso, reviewed_by: adminEmail, rejection_reason: rejectionReason },
    request_metadata: requestMetadata,
  });
  if (!audit.ok) {
    return { ok: false, status: 500, error: `Action succeeded but audit logging failed: ${audit.error}` };
  }

  return { ok: true };
}
