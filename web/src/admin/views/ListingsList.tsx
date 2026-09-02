import { useCallback, useEffect, useState } from 'react';
import { adminApi, Listing, ListingFilters } from '../lib/adminApi';

type Props = {
  initialFilters?: ListingFilters;
  onOpenListing: (id: string) => void;
};

const PAGE_SIZE = 20;

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

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
      </div>

      {error ? <p className="admin-error">{error}</p> : null}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
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
            </tr>
          </thead>
          <tbody>
            {data.map((l) => (
              <tr key={l.id} className="admin-row-clickable" onClick={() => onOpenListing(l.id)}>
                <td>{l.name}</td>
                <td>₹{l.price_rupees}</td>
                <td>
                  <span className={`admin-badge admin-badge-source-${l.source}`}>{l.source}</span>
                </td>
                <td>
                  <span className={`admin-badge admin-badge-verification-${l.verification_status}`}>
                    {l.verification_status}
                  </span>
                </td>
                <td>
                  {l.archived_at ? <span className="admin-badge admin-badge-archived">Archived</span> : null}
                  {l.is_hidden ? <span className="admin-badge admin-badge-hidden">Hidden</span> : null}
                  {!l.is_hidden && !l.archived_at ? <span className="admin-badge admin-badge-visible">Visible</span> : null}
                </td>
                <td>{new Date(l.created_at).toLocaleDateString()}</td>
                <td>{new Date(l.updated_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {data.length === 0 && !loading ? (
              <tr>
                <td colSpan={7}>No listings match these filters.</td>
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
