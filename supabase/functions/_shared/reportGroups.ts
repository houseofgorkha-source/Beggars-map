// Shared pending-report-group query, used by both admin-reports' `list`
// action and admin-dashboard's stats (pending report count). Extracted so
// the grouping logic (by listing_id + reason, with a distinct-reporter
// count) exists in exactly one place — see adminAuth.ts's header comment
// for why duplicated logic is avoided across these functions.

import { SupabaseClient } from 'npm:@supabase/supabase-js@2';

type ReportRow = {
  listing_id: string;
  reason: string;
  reported_by: string;
  created_at: string;
  listings: { name: string; is_hidden: boolean } | null;
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

export async function getPendingReportGroups(
  adminClient: SupabaseClient
): Promise<{ data: ReportGroup[] } | { error: string }> {
  const { data, error } = await adminClient
    .from('reports')
    .select('listing_id, reason, reported_by, created_at, listings(name, is_hidden)')
    .is('resolved_at', null);

  if (error) return { error: error.message };

  // Grouped by (listing, reason) — reported_by is only ever used here to
  // size a Set for the distinct-reporter count; raw ids are never
  // returned, so no reporter identity leaves this function.
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

  return { data: result };
}
