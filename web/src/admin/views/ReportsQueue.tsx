import { useCallback, useEffect, useState } from 'react';
import { adminApi, ReportGroup } from '../lib/adminApi';

type Props = {
  adminEmail: string;
  onViewHistory: (listingId: string) => void;
};

export default function ReportsQueue({ adminEmail, onViewHistory }: Props) {
  const [groups, setGroups] = useState<ReportGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    adminApi
      .reportsList()
      .then((res) => setGroups(res.data))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runAction(action: 'hide' | 'unhide' | 'resolve', group: ReportGroup) {
    const key = `${group.listingId}::${group.reason}::${action}`;
    setBusyKey(key);
    setError(null);
    setMessage(null);
    try {
      if (action === 'hide') await adminApi.reportsHide(group.listingId);
      else if (action === 'unhide') await adminApi.reportsUnhide(group.listingId);
      else {
        await adminApi.reportsResolve(group.listingId, group.reason);
        setMessage(`Resolved by ${adminEmail} at ${new Date().toLocaleString()}.`);
      }
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div>
      {error ? <p className="admin-error">{error}</p> : null}
      {message ? <p className="admin-success">{message}</p> : null}

      {groups.length === 0 ? (
        <p>No pending reports.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Listing</th>
                <th>Reason</th>
                <th>Reports</th>
                <th>Distinct reporters</th>
                <th>Latest</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const rowKey = `${g.listingId}::${g.reason}`;
                return (
                  <tr key={rowKey}>
                    <td>{g.name}</td>
                    <td>{g.reason}</td>
                    <td>{g.reportCount}</td>
                    <td>{g.distinctReporterCount}</td>
                    <td>{new Date(g.latest).toLocaleString()}</td>
                    <td>{g.isHidden ? 'Hidden' : 'Visible'}</td>
                    <td className="admin-actions">
                      <button
                        className="admin-button admin-button-small"
                        disabled={busyKey === `${rowKey}::hide` || g.isHidden}
                        onClick={() => runAction('hide', g)}
                      >
                        Hide
                      </button>
                      <button
                        className="admin-button admin-button-small"
                        disabled={busyKey === `${rowKey}::unhide` || !g.isHidden}
                        onClick={() => runAction('unhide', g)}
                      >
                        Unhide
                      </button>
                      <button
                        className="admin-button admin-button-small admin-button-secondary"
                        disabled={busyKey === `${rowKey}::resolve`}
                        onClick={() => runAction('resolve', g)}
                      >
                        Dismiss
                      </button>
                      <button
                        className="admin-button admin-button-small admin-button-secondary"
                        onClick={() => onViewHistory(g.listingId)}
                      >
                        History
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
