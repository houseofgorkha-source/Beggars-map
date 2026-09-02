import { useEffect, useState } from 'react';
import { adminApi, DashboardStats } from '../lib/adminApi';

type Props = {
  onNavigateReports: () => void;
  onNavigateListings: (filters: { isHidden?: boolean; archived?: boolean }) => void;
  onNavigateAudit: () => void;
};

export default function Dashboard({ onNavigateReports, onNavigateListings, onNavigateAudit }: Props) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .dashboardStats()
      .then((res) => setStats(res.data))
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="admin-error">{error}</p>;
  if (!stats) return <p>Loading…</p>;

  return (
    <div>
      <div className="admin-tiles">
        <div className="admin-tile">
          <div className="admin-tile-value">{stats.totalListings}</div>
          <div className="admin-tile-label">Total listings</div>
        </div>
        <div className="admin-tile">
          <div className="admin-tile-value">{stats.newListings7d}</div>
          <div className="admin-tile-label">New in 7 days</div>
        </div>
        <div className="admin-tile">
          <div className="admin-tile-value">{stats.newListings30d}</div>
          <div className="admin-tile-label">New in 30 days</div>
        </div>
        <button className="admin-tile admin-tile-clickable" onClick={onNavigateReports}>
          <div className="admin-tile-value">{stats.pendingReportGroups}</div>
          <div className="admin-tile-label">Pending reports</div>
        </button>
        <button className="admin-tile admin-tile-clickable" onClick={() => onNavigateListings({ isHidden: true })}>
          <div className="admin-tile-value">{stats.hiddenListings}</div>
          <div className="admin-tile-label">Hidden listings</div>
        </button>
        <button className="admin-tile admin-tile-clickable" onClick={() => onNavigateListings({ archived: true })}>
          <div className="admin-tile-value">{stats.archivedListings}</div>
          <div className="admin-tile-label">Archived listings</div>
        </button>
      </div>

      <div className="admin-section">
        <h2>By source</h2>
        <div className="admin-badges">
          {Object.entries(stats.bySource).map(([source, count]) => (
            <span key={source} className={`admin-badge admin-badge-source-${source}`}>
              {source}: {count}
            </span>
          ))}
        </div>
      </div>

      <div className="admin-section">
        <div className="admin-section-header">
          <h2>Recent activity</h2>
          <button className="admin-button admin-button-small admin-button-secondary" onClick={onNavigateAudit}>
            View full audit log
          </button>
        </div>
        {stats.recentActivity.length === 0 ? (
          <p>No admin activity yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentActivity.map((entry) => (
                  <tr key={entry.id}>
                    <td>{new Date(entry.created_at).toLocaleString()}</td>
                    <td>{entry.actor_label}</td>
                    <td>{entry.action}</td>
                    <td>
                      {entry.target_type} · {entry.target_id.slice(0, 8)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
