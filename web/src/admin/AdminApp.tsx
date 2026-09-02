import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { adminSupabase } from './adminSupabase';

type ReportGroup = {
  listingId: string;
  name: string;
  reason: string;
  reportCount: number;
  distinctReporterCount: number;
  latest: string;
  isHidden: boolean;
};

type AuthState = 'checking' | 'signed-out' | 'not-authorized' | 'authorized';

export default function AdminApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [groups, setGroups] = useState<ReportGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    setError(null);
    const { data, error: invokeError } = await adminSupabase.functions.invoke<{ data: ReportGroup[] }>('admin-reports', {
      body: { action: 'list' },
    });
    if (invokeError) {
      // A non-2xx function response surfaces as invokeError — its
      // .context is the raw Response, so a 403 means "not authorized"
      // specifically rather than a generic failure.
      const status = (invokeError as { context?: { status?: number } }).context?.status;
      if (status === 403) {
        setAuthState('not-authorized');
        return;
      }
      setError(invokeError.message);
      return;
    }
    setGroups(data?.data ?? []);
    setAuthState('authorized');
  }, []);

  useEffect(() => {
    adminSupabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) loadReports();
      else setAuthState('signed-out');
    });
    const { data: sub } = adminSupabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession) loadReports();
      else setAuthState('signed-out');
    });
    return () => sub.subscription.unsubscribe();
  }, [loadReports]);

  async function signIn() {
    await adminSupabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/admin.html` },
    });
  }

  async function signOut() {
    await adminSupabase.auth.signOut();
    setGroups([]);
    setAuthState('signed-out');
  }

  async function runAction(action: 'hide' | 'unhide' | 'resolve', group: ReportGroup) {
    const key = `${group.listingId}::${group.reason}::${action}`;
    setBusyKey(key);
    setError(null);
    const { error: invokeError } = await adminSupabase.functions.invoke('admin-reports', {
      body: { action, listingId: group.listingId, reason: group.reason },
    });
    setBusyKey(null);
    if (invokeError) {
      setError(invokeError.message);
      return;
    }
    await loadReports();
  }

  if (authState === 'checking') {
    return (
      <div className="admin-shell">
        <p>Loading…</p>
      </div>
    );
  }

  if (authState === 'signed-out') {
    return (
      <div className="admin-shell">
        <h1>Beggars Map — Admin</h1>
        <p>Sign in with the admin Google account to review reports.</p>
        <button className="admin-button" onClick={signIn}>
          Sign in with Google
        </button>
      </div>
    );
  }

  if (authState === 'not-authorized') {
    return (
      <div className="admin-shell">
        <h1>Beggars Map — Admin</h1>
        <p>This account isn't authorized to view report data.</p>
        <button className="admin-button admin-button-secondary" onClick={signOut}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="admin-shell">
      <div className="admin-header">
        <h1>Beggars Map — Admin</h1>
        <button className="admin-button admin-button-secondary" onClick={signOut}>
          Sign out ({session?.user.email})
        </button>
      </div>

      {error ? <p className="admin-error">{error}</p> : null}

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
