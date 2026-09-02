import { useCallback, useEffect, useState } from 'react';
import { adminApi, Listing, ListingFilters } from '../lib/adminApi';

type Props = {
  initialFilters?: ListingFilters;
  onOpenListing: (id: string) => void;
};

const PAGE_SIZE = 20;

type PendingBulk = { mode: 'selected' | 'filtered' | 'all'; count: number };

export default function ListingsList({ initialFilters, onOpenListing }: Props) {
  const [filters, setFilters] = useState<ListingFilters>(initialFilters ?? {});
  const [searchInput, setSearchInput] = useState(initialFilters?.search ?? '');
  const [sortBy, setSortBy] = useState('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Listing[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingBulk, setPendingBulk] = useState<PendingBulk | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    adminApi
      .listingsList(page, PAGE_SIZE, filters, sortBy, sortDir)
      .then((res) => {
        setData(res.data);
        setTotal(res.total);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, filters, sortBy, sortDir]);

  useEffect(() => {
    load();
  }, [load]);

  // Debounce the free-text search separately from the other filters, which
  // apply immediately on change.
  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1);
      setFilters((f) => ({ ...f, search: searchInput || undefined }));
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  function updateFilter<K extends keyof ListingFilters>(key: K, value: ListingFilters[K]) {
    setPage(1);
    setSelected(new Set());
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function toggleSort(column: string) {
    if (sortBy === column) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(column);
      setSortDir('asc');
    }
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Deliberately raw reviewed_at, not isNew: "mark selected" can act on an
  // explicitly-chosen legacy/pre-baseline listing too (the baseline only
  // gates what counts as NEW by default, never what an admin can
  // explicitly choose to review) — matches bulkMarkReviewed's own
  // "listingIds" mode on the server, which uses the same raw condition.
  const selectedUnreviewedCount = data.filter((l) => selected.has(l.id) && !l.reviewed_at).length;

  // "Mark all filtered" and "mark all new" need the exact count of
  // currently-unreviewed matches BEFORE showing a confirmation — reusing
  // the existing `list` action with pageSize=1 gets that count with no
  // new endpoint, since PostgREST's exact count already comes back on
  // every list call regardless of page size.
  async function openAllConfirm(mode: 'filtered' | 'all') {
    setError(null);
    const effectiveFilters: ListingFilters = mode === 'filtered' ? { ...filters, reviewed: false } : { reviewed: false };
    try {
      const res = await adminApi.listingsList(1, 1, effectiveFilters, 'created_at', 'desc');
      setPendingBulk({ mode, count: res.total });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function openSelectedConfirm() {
    if (selectedUnreviewedCount === 0) return;
    setPendingBulk({ mode: 'selected', count: selectedUnreviewedCount });
  }

  async function confirmBulk() {
    if (!pendingBulk) return;
    setBulkBusy(true);
    setError(null);
    setMessage(null);
    try {
      let res: { updatedCount: number };
      if (pendingBulk.mode === 'selected') {
        res = await adminApi.listingsBulkMarkReviewed({ listingIds: Array.from(selected) });
      } else if (pendingBulk.mode === 'filtered') {
        res = await adminApi.listingsBulkMarkReviewed({ filters: { ...filters, reviewed: false } });
      } else {
        res = await adminApi.listingsBulkMarkReviewed({ filters: { reviewed: false } });
      }
      setMessage(`Marked ${res.updatedCount} listing(s) as reviewed.`);
      setSelected(new Set());
      setPendingBulk(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function markOneReviewed(id: string) {
    setError(null);
    setMessage(null);
    try {
      await adminApi.listingsMarkReviewed(id);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <div className="admin-filters">
        <input
          className="admin-input"
          placeholder="Search name, note, location…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <select
          className="admin-select"
          value={filters.source ?? ''}
          onChange={(e) => updateFilter('source', e.target.value || undefined)}
        >
          <option value="">All sources</option>
          <option value="user">user</option>
          <option value="admin">admin</option>
          <option value="import">import</option>
          <option value="legacy">legacy</option>
        </select>
        <select
          className="admin-select"
          value={filters.verificationStatus ?? ''}
          onChange={(e) => updateFilter('verificationStatus', e.target.value || undefined)}
        >
          <option value="">All verification statuses</option>
          <option value="unverified">unverified</option>
          <option value="pending_review">pending_review</option>
          <option value="human_verified">human_verified</option>
          <option value="rejected">rejected</option>
        </select>
        <select
          className="admin-select"
          value={filters.isHidden === undefined ? '' : String(filters.isHidden)}
          onChange={(e) => updateFilter('isHidden', e.target.value === '' ? undefined : e.target.value === 'true')}
        >
          <option value="">Visible + hidden</option>
          <option value="true">Hidden only</option>
          <option value="false">Visible only</option>
        </select>
        <select
          className="admin-select"
          value={filters.archived === undefined ? '' : String(filters.archived)}
          onChange={(e) => updateFilter('archived', e.target.value === '' ? undefined : e.target.value === 'true')}
        >
          <option value="">Active + archived</option>
          <option value="true">Archived only</option>
          <option value="false">Not archived</option>
        </select>
        <select
          className="admin-select"
          value={filters.reviewed === undefined ? '' : String(filters.reviewed)}
          onChange={(e) => updateFilter('reviewed', e.target.value === '' ? undefined : e.target.value === 'true')}
        >
          <option value="">New + reviewed</option>
          <option value="false">New (unreviewed) only</option>
          <option value="true">Reviewed only</option>
        </select>
      </div>

      <div className="admin-bulk-toolbar">
        <button
          className="admin-button admin-button-small admin-button-secondary"
          disabled={selectedUnreviewedCount === 0}
          onClick={openSelectedConfirm}
        >
          Mark selected as reviewed {selected.size > 0 ? `(${selectedUnreviewedCount})` : ''}
        </button>
        <button className="admin-button admin-button-small admin-button-secondary" onClick={() => openAllConfirm('filtered')}>
          Mark all filtered new listings as reviewed
        </button>
        <button className="admin-button admin-button-small admin-button-secondary" onClick={() => openAllConfirm('all')}>
          Mark all new listings as reviewed
        </button>
      </div>

      {pendingBulk ? (
        <div className="admin-confirm-box">
          <p>
            {pendingBulk.count === 0
              ? 'No unreviewed listings match this action.'
              : `This will mark exactly ${pendingBulk.count} listing(s) as reviewed. This cannot be bulk-undone (each can be individually marked unreviewed afterward).`}
          </p>
          <div className="admin-actions">
            <button
              className="admin-button admin-button-small"
              disabled={bulkBusy || pendingBulk.count === 0}
              onClick={confirmBulk}
            >
              Confirm
            </button>
            <button className="admin-button admin-button-small admin-button-secondary" onClick={() => setPendingBulk(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="admin-error">{error}</p> : null}
      {message ? <p className="admin-success">{message}</p> : null}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th></th>
              <th className="admin-sortable" onClick={() => toggleSort('name')}>
                Name {sortBy === 'name' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
              </th>
              <th className="admin-sortable" onClick={() => toggleSort('price_rupees')}>
                Price {sortBy === 'price_rupees' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
              </th>
              <th>Source</th>
              <th>Verification</th>
              <th>Status</th>
              <th className="admin-sortable" onClick={() => toggleSort('created_at')}>
                Created {sortBy === 'created_at' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
              </th>
              <th className="admin-sortable" onClick={() => toggleSort('updated_at')}>
                Updated {sortBy === 'updated_at' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((l) => {
              const isNew = l.isNew; // server-computed — never re-derive from reviewed_at
              return (
                <tr key={l.id} className={isNew ? 'admin-row-new' : ''}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      onChange={() => toggleSelected(l.id)}
                      aria-label={`Select ${l.name}`}
                    />
                  </td>
                  <td className="admin-row-clickable" onClick={() => onOpenListing(l.id)}>
                    {isNew ? <span className="admin-new-dot" title="New — not yet reviewed" /> : null}
                    {l.name}
                    {isNew ? <span className="admin-badge admin-badge-new">NEW</span> : null}
                  </td>
                  <td className="admin-row-clickable" onClick={() => onOpenListing(l.id)}>
                    ₹{l.price_rupees}
                  </td>
                  <td className="admin-row-clickable" onClick={() => onOpenListing(l.id)}>
                    <span className={`admin-badge admin-badge-source-${l.source}`}>{l.source}</span>
                  </td>
                  <td className="admin-row-clickable" onClick={() => onOpenListing(l.id)}>
                    <span className={`admin-badge admin-badge-verification-${l.verification_status}`}>
                      {l.verification_status}
                    </span>
                  </td>
                  <td className="admin-row-clickable" onClick={() => onOpenListing(l.id)}>
                    {l.archived_at ? <span className="admin-badge admin-badge-archived">Archived</span> : null}
                    {l.is_hidden ? <span className="admin-badge admin-badge-hidden">Hidden</span> : null}
                    {!l.is_hidden && !l.archived_at ? <span className="admin-badge admin-badge-visible">Visible</span> : null}
                  </td>
                  <td className="admin-row-clickable" onClick={() => onOpenListing(l.id)}>
                    {new Date(l.created_at).toLocaleDateString()}
                  </td>
                  <td className="admin-row-clickable" onClick={() => onOpenListing(l.id)}>
                    {new Date(l.updated_at).toLocaleDateString()}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {!l.reviewed_at ? (
                      <button className="admin-button admin-button-small admin-button-secondary" onClick={() => markOneReviewed(l.id)}>
                        Mark reviewed
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {data.length === 0 && !loading ? (
              <tr>
                <td colSpan={9}>No listings match these filters.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="admin-pagination">
        <button
          className="admin-button admin-button-small admin-button-secondary"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <span>
          Page {page} of {totalPages} ({total} total)
        </span>
        <button
          className="admin-button admin-button-small admin-button-secondary"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
