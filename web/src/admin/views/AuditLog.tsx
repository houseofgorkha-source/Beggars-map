import { useCallback, useEffect, useState } from 'react';
import { adminApi, AuditEntry, AuditLogFilters } from '../lib/adminApi';

type Props = {
  initialFilters?: AuditLogFilters;
  onOpenListing: (id: string) => void;
};

const PAGE_SIZE = 20;

export default function AuditLog({ initialFilters, onOpenListing }: Props) {
  const [filters, setFilters] = useState<AuditLogFilters>(initialFilters ?? {});
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    adminApi
      .auditLog(page, PAGE_SIZE, filters)
      .then((res) => {
        setData(res.data);
        setTotal(res.total);
      })
      .catch((err) => setError(err.message));
  }, [page, filters]);

  useEffect(() => {
    load();
  }, [load]);

  function updateFilter<K extends keyof AuditLogFilters>(key: K, value: AuditLogFilters[K]) {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value }));
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="admin-filters">
        <select className="admin-select" value={filters.actorType ?? ''} onChange={(e) => updateFilter('actorType', e.target.value || undefined)}>
          <option value="">All actors</option>
          <option value="admin">admin</option>
          <option value="discovery_pipeline">discovery_pipeline</option>
        </select>
        <select className="admin-select" value={filters.action ?? ''} onChange={(e) => updateFilter('action', e.target.value || undefined)}>
          <option value="">All actions</option>
          <option value="create">create</option>
          <option value="import">import</option>
          <option value="edit">edit</option>
          <option value="hide">hide</option>
          <option value="unhide">unhide</option>
          <option value="archive">archive</option>
          <option value="unarchive">unarchive</option>
          <option value="resolve_report">resolve_report</option>
        </select>
        <select className="admin-select" value={filters.targetType ?? ''} onChange={(e) => updateFilter('targetType', e.target.value || undefined)}>
          <option value="">All target types</option>
          <option value="listing">listing</option>
          <option value="report">report</option>
        </select>
        {filters.targetId ? (
          <span className="admin-badge">
            target: {filters.targetId.slice(0, 8)}…{' '}
            <button className="admin-link" onClick={() => updateFilter('targetId', undefined)}>
              clear
            </button>
          </span>
        ) : null}
      </div>

      {error ? <p className="admin-error">{error}</p> : null}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {data.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.created_at).toLocaleString()}</td>
                <td>
                  {entry.actor_label} <span className="admin-muted">({entry.actor_type})</span>
                </td>
                <td>{entry.action}</td>
                <td>
                  {entry.target_type === 'listing' ? (
                    <button className="admin-link" onClick={() => onOpenListing(entry.target_id)}>
                      listing · {entry.target_id.slice(0, 8)}…
                    </button>
                  ) : (
                    <span>
                      report · {entry.target_id.slice(0, 8)}…
                    </span>
                  )}
                </td>
                <td>
                  <details>
                    <summary>view</summary>
                    <pre className="admin-json">{JSON.stringify({ before: entry.before_state, after: entry.after_state, request: entry.request_metadata }, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
            {data.length === 0 ? (
              <tr>
                <td colSpan={5}>No audit entries match these filters.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="admin-pagination">
        <button className="admin-button admin-button-small admin-button-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {totalPages} ({total} total)
        </span>
        <button className="admin-button admin-button-small admin-button-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
