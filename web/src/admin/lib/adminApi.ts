// Thin wrapper over `adminSupabase.functions.invoke` for every admin-*
// Edge Function. One place that knows the action names/payload shapes, so
// view components never build raw invoke() calls themselves. No service-
// role credentials ever touch this file or anything it calls — the
// browser only ever holds the admin's own Google-OAuth session (via
// adminSupabase, the anon key), exactly like admin v1.

import { adminSupabase } from '../adminSupabase';

export class AdminApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
  }
}

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await adminSupabase.functions.invoke<T>(fn, { body });
  if (error) {
    // A non-2xx function response surfaces as invokeError — its .context
    // is the raw Response, and the function's own JSON body (with the
    // real error message) has already been consumed by supabase-js at
    // this point, so .message is the best we can surface here.
    const status = (error as { context?: { status?: number } }).context?.status;
    throw new AdminApiError(error.message, status);
  }
  return data as T;
}

export type Listing = {
  id: string;
  created_by: string;
  name: string;
  note: string | null;
  price_rupees: number;
  photo_url: string | null;
  latitude: number;
  longitude: number;
  city: string;
  is_hidden: boolean;
  created_at: string;
  location_label: string | null;
  source: 'user' | 'admin' | 'import' | 'legacy';
  actor_type: 'user' | 'admin' | 'discovery_pipeline' | 'unknown';
  actor_label: string | null;
  evidence_url: string | null;
  evidence_date: string | null;
  verification_status: 'unverified' | 'pending_review' | 'human_verified' | 'rejected';
  archived_at: string | null;
  updated_at: string;
  last_modified_by: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

export type ListingPhoto = {
  id: string;
  listing_id: string;
  photo_url: string;
  storage_path: string;
  position: number;
  created_at: string;
};

export type AuditEntry = {
  id: string;
  actor_type: 'admin' | 'discovery_pipeline';
  actor_label: string;
  action: string;
  target_type: 'listing' | 'report';
  target_id: string;
  before_state: unknown;
  after_state: unknown;
  request_metadata: unknown;
  created_at: string;
};

export type ReportGroup = {
  listingId: string;
  name: string;
  reason: string;
  reportCount: number;
  distinctReporterCount: number;
  latest: string;
  isHidden: boolean;
};

export type ListingFilters = {
  source?: string;
  verificationStatus?: string;
  isHidden?: boolean;
  archived?: boolean;
  reviewed?: boolean;
  search?: string;
};

export type DashboardStats = {
  totalListings: number;
  newListings7d: number;
  newListings30d: number;
  hiddenListings: number;
  archivedListings: number;
  unreviewedListings: number;
  pendingReportGroups: number;
  bySource: Record<string, number>;
  recentActivity: AuditEntry[];
};

export type AuditLogFilters = {
  actorType?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
};

export const adminApi = {
  dashboardStats: () => invoke<{ data: DashboardStats }>('admin-dashboard', { action: 'stats' }),

  auditLog: (page: number, pageSize: number, filters: AuditLogFilters = {}) =>
    invoke<{ data: AuditEntry[]; total: number; page: number; pageSize: number }>('admin-dashboard', {
      action: 'auditLog',
      page,
      pageSize,
      filters,
    }),

  reportsList: () => invoke<{ data: ReportGroup[] }>('admin-reports', { action: 'list' }),
  reportsHide: (listingId: string) => invoke<{ success: true }>('admin-reports', { action: 'hide', listingId }),
  reportsUnhide: (listingId: string) => invoke<{ success: true }>('admin-reports', { action: 'unhide', listingId }),
  reportsResolve: (listingId: string, reason: string) =>
    invoke<{ success: true }>('admin-reports', { action: 'resolve', listingId, reason }),

  listingsList: (page: number, pageSize: number, filters: ListingFilters, sortBy: string, sortDir: 'asc' | 'desc') =>
    invoke<{ data: Listing[]; total: number; page: number; pageSize: number }>('admin-listings', {
      action: 'list',
      page,
      pageSize,
      filters,
      sortBy,
      sortDir,
    }),

  listingsGet: (listingId: string) =>
    invoke<{ data: { listing: Listing; photos: ListingPhoto[]; auditHistory: AuditEntry[] } }>('admin-listings', {
      action: 'get',
      listingId,
    }),

  listingsUpdate: (listingId: string, fields: Record<string, unknown>) =>
    invoke<{ success: true; data: Listing }>('admin-listings', { action: 'update', listingId, fields }),

  listingsHide: (listingId: string) => invoke<{ success: true }>('admin-listings', { action: 'hide', listingId }),
  listingsUnhide: (listingId: string) => invoke<{ success: true }>('admin-listings', { action: 'unhide', listingId }),
  listingsArchive: (listingId: string) => invoke<{ success: true }>('admin-listings', { action: 'archive', listingId }),
  listingsUnarchive: (listingId: string) =>
    invoke<{ success: true }>('admin-listings', { action: 'unarchive', listingId }),

  listingsMarkReviewed: (listingId: string) =>
    invoke<{ success: true }>('admin-listings', { action: 'markReviewed', listingId }),
  listingsMarkUnreviewed: (listingId: string) =>
    invoke<{ success: true }>('admin-listings', { action: 'markUnreviewed', listingId }),

  // Exactly one of listingIds/filters should be passed — listingIds for an
  // explicit selection, filters (possibly {}) to act on every currently-
  // unreviewed listing matching those filters server-side, regardless of
  // pagination.
  listingsBulkMarkReviewed: (opts: { listingIds?: string[]; filters?: ListingFilters }) =>
    invoke<{ success: true; updatedCount: number }>('admin-listings', { action: 'bulkMarkReviewed', ...opts }),

  getSettings: () => invoke<{ data: Record<string, unknown> }>('admin-dashboard', { action: 'getSettings' }),
  updateSetting: (key: string, value: boolean) =>
    invoke<{ success: true }>('admin-dashboard', { action: 'updateSetting', key, value }),
};
