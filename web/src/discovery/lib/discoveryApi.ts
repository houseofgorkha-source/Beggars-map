// Thin wrapper over `discoverySupabase.functions.invoke` for the
// discovery-workbench Edge Function — same shape as web/src/admin/lib/
// adminApi.ts. One place that knows the action names/payload shapes, so
// view components never build raw invoke() calls themselves. No
// service-role credentials ever touch this file or anything it calls — the
// browser only ever holds the intern's own Google-OAuth session (via
// discoverySupabase, the anon key).

import { discoverySupabase } from '../discoverySupabase';

export class DiscoveryApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DiscoveryApiError';
    this.status = status;
  }
}

async function invoke<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await discoverySupabase.functions.invoke<T>('discovery-workbench', { body: { action, ...params } });
  if (error) {
    // A non-2xx function response surfaces as invokeError — its .context
    // is the raw Response, and the function's own JSON body (with the real
    // error message) has already been consumed by supabase-js at this
    // point, so .message is the best we can surface here. Same caveat
    // adminApi.ts's own invoke() documents.
    const status = (error as { context?: { status?: number } }).context?.status;
    throw new DiscoveryApiError(error.message, status);
  }
  return data as T;
}

export type DishEntry = { dish: string; price: number };

export type Candidate = {
  place_id: string;
  name: string;
  formatted_address: string | null;
  latitude: number | null;
  longitude: number | null;
  primary_type: string | null;
  business_status: string | null;
  google_price_level: string | null;
  website_uri: string | null;
  google_maps_uri: string | null;
  discovery_sources: string | null;
  phone: string | null;
  number_valid: 'Yes' | 'No' | 'No Answer' | null;
  menu_list_under_100: 'Yes' | 'No' | null;
  dishes: DishEntry[] | null;
  notes: string | null;
  batch_id: string;
  pushed_at: string;
  updated_at: string;
};

export type Photo = { name: string; url: string };

// A candidate is "reviewed" purely as a workbench workflow state — this
// mirrors tools/discovery/workbench-sync.mjs's own isReviewedDbRow() exactly
// and must be kept in sync with it. It has nothing to do with, and must
// never be confused with, the discovery pipeline's actual food-qualification
// logic (tools/discovery/matching.mjs's classifyOffering) — that logic is
// untouched by this feature.
export function isReviewed(candidate: Candidate): boolean {
  if (!candidate.number_valid) return false;
  if (candidate.menu_list_under_100 !== 'Yes' && candidate.menu_list_under_100 !== 'No') return false;
  if (candidate.menu_list_under_100 === 'Yes' && !candidate.notes) return false;
  return true;
}

export const discoveryApi = {
  list: () => invoke<{ data: Candidate[] }>('list', {}),
  get: (placeId: string) => invoke<{ data: Candidate }>('get', { placeId }),
  update: (placeId: string, fields: Record<string, unknown>) => invoke<{ success: true; data: Candidate }>('update', { placeId, fields }),

  createPhotoUploadUrl: (placeId: string, filename: string) =>
    invoke<{ data: { path: string; signedUrl: string; token: string } }>('createPhotoUploadUrl', { placeId, filename }),
  listPhotos: (placeId: string) => invoke<{ data: Photo[] }>('listPhotos', { placeId }),
  addPhotoFromUrl: (placeId: string, imageUrl: string) =>
    invoke<{ success: true; data: { name: string; url: string | null } }>('addPhotoFromUrl', { placeId, imageUrl }),
  removePhoto: (placeId: string, filename: string) => invoke<{ success: true }>('removePhoto', { placeId, filename }),
};
