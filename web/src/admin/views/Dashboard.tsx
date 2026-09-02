import { useEffect, useState } from 'react';
import { adminApi, DashboardStats } from '../lib/adminApi';

type Props = {
  onNavigateReports: () => void;
  onNavigateListings: (filters: { isHidden?: boolean; archived?: boolean; reviewed?: boolean }) => void;
  onNavigateAudit: () => void;
};

export default function Dashboard({ onNavigateReports, onNavigateListings, onNavigateAudit }: Props) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoReview, setAutoReview] = useState<boolean | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);

  useEffect(() => {
    adminApi
      .dashboardStats()
      .then((res) => setStats(res.data))
      .catch((err) => setError(err.message));
    adminApi
      .getSettings()
      .then((res) => setAutoReview(res.data.import_default_reviewed === true))
      .catch((err) => setSettingsError(err.message));
  }, []);

  async function changeAutoReview(value: boolean) {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      await adminApi.updateSetting('import_default_reviewed', value);
      setAutoReview(value);
    } catch (err) {
      setSettingsError((err as Error).message);
    } finally {
      setSettingsSaving(false);
    }
  }

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
        <button className="admin-tile admin-tile-clickable" onClick={() => onNavigateListings({ reviewed: false })}>
          <div className="admin-tile-value">{stats.unreviewedListings}</div>
          <div className="admin-tile-label">New / unreviewed</div>
        </button>
      </div>

      <div className="admin-section">
        <h2>Discovery import default</h2>
        {settingsError ? <p className="admin-error">{settingsError}</p> : null}
        {autoReview === null ? (
          <p className="admin-muted">Loading…</p>
        ) : (
          <div className="admin-settings-radios">
            <label>
              <input
                type="radio"
                name="import-default-reviewed"
                checked={!autoReview}
                disabled={settingsSaving}
                onChange={() => changeAutoReview(false)}
              />
              Always require review (default) — new imports show up as NEW until an admin reviews them
            </label>
            <label>
              <input
                type="radio"
                name="import-default-reviewed"
                checked={autoReview}
                disabled={settingsSaving}
                onChange={() => changeAutoReview(true)}
              />
              Automatically mark imported listings as reviewed
            </label>
          </div>
        )}
        <p className="admin-muted admin-hint">
          Applies only to future import runs — changing this never marks existing listings reviewed or unreviewed.
        </p>
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
