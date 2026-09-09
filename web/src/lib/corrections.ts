// User-proposed corrections to a listing's own canonical fields (name,
// dishes/prices, location) — listing_corrections, migration 0023. Staged
// only: nothing here ever writes to `listings` directly (RLS has no public
// UPDATE path to it at all — see that migration's header). A correction
// only reaches `listings` via the admin-corrections Edge Function's
// `approve` action, run as service_role.
//
// Mirrors lib/reviews.ts's shape — a thin wrapper file per table-family.

import { supabase } from './supabase';
import type { DishEntry } from './dishes';

export type CorrectionType = 'name' | 'dishes' | 'location';
export type CorrectionStatus = 'pending' | 'approved' | 'rejected';

export type ListingCorrection = {
  id: string;
  listing_id: string;
  created_by: string;
  correction_type: CorrectionType;
  proposed_name: string | null;
  proposed_dishes: DishEntry[] | null;
  proposed_latitude: number | null;
  proposed_longitude: number | null;
  proposed_location_label: string | null;
  submitter_note: string | null;
  status: CorrectionStatus;
  created_at: string;
};

const CORRECTION_COLUMNS =
  'id, listing_id, created_by, correction_type, proposed_name, proposed_dishes, proposed_latitude, proposed_longitude, proposed_location_label, submitter_note, status, created_at';

// Own-rows-only per 0023's RLS policy — this can never return another
// user's pending correction. Used to show "you already suggested a
// correction for this, pending review" instead of inviting a duplicate
// submission for the same field.
export async function fetchMyPendingCorrections(listingId: string, userId: string): Promise<ListingCorrection[]> {
  const { data } = await supabase
    .from('listing_corrections')
    .select(CORRECTION_COLUMNS)
    .eq('listing_id', listingId)
    .eq('created_by', userId)
    .eq('status', 'pending');
  return (data ?? []) as unknown as ListingCorrection[];
}

async function insertCorrection(input: Record<string, unknown>): Promise<{ id: string } | { error: string }> {
  const { data, error } = await supabase.from('listing_corrections').insert(input).select('id').single();
  if (error || !data) return { error: error?.message ?? 'Could not submit your correction.' };
  return { id: data.id };
}

export function submitNameCorrection(listingId: string, userId: string, proposedName: string, note: string | null) {
  return insertCorrection({
    listing_id: listingId,
    created_by: userId,
    correction_type: 'name',
    proposed_name: proposedName,
    submitter_note: note,
  });
}

export function submitDishesCorrection(listingId: string, userId: string, proposedDishes: DishEntry[], note: string | null) {
  return insertCorrection({
    listing_id: listingId,
    created_by: userId,
    correction_type: 'dishes',
    proposed_dishes: proposedDishes,
    submitter_note: note,
  });
}

export function submitLocationCorrection(
  listingId: string,
  userId: string,
  latitude: number,
  longitude: number,
  locationLabel: string | null,
  note: string | null
) {
  return insertCorrection({
    listing_id: listingId,
    created_by: userId,
    correction_type: 'location',
    proposed_latitude: latitude,
    proposed_longitude: longitude,
    proposed_location_label: locationLabel,
    submitter_note: note,
  });
}
