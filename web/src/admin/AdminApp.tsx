import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { adminSupabase } from './adminSupabase';
import Dashboard from './views/Dashboard';
import ListingsList from './views/ListingsList';
import ListingDetail from './views/ListingDetail';
import ReportsQueue from './views/ReportsQueue';
import AuditLog from './views/AuditLog';
import { adminApi, AuditLogFilters, ListingFilters } from './lib/adminApi';

type AuthState = 'checking' | 'signed-out' | 'not-authorized' | 'authorized';
type View = 'dashboard' | 'listings' | 'listing-detail' | 'reports' | 'audit';

export default function AdminApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [authState, setAuthState] = useState<AuthState>('checking');

  const [view, setView] = useState<View>('dashboard');
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [listingsFilters, setListingsFilters] = useState<ListingFilters>({});
  const [auditFilters, setAuditFilters] = useState<AuditLogFilters>({});
  const [navKey, setNavKey] = useState(0);

  const checkAuthorized = useCallback(async () => {
    // A real check that the caller's email is admin-authorized happens
    // server-side on every Edge Function call — this is only a UI gate to
    // avoid flashing admin views before we know. Use the cheapest
    // read-only call (dashboard stats) to confirm; a 403 flips us to
    // not-authorized without ever having rendered report/listing data.
    try {
      await adminApi.dashboardStats();
      setAuthState('authorized');
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403) {
        setAuthState('not-authorized');
      } else {
        // Any other failure (network, 500, etc.) must not be treated as
        // "authorized" — fail closed, surface it as not-authorized too
        // rather than rendering admin views on an unconfirmed state.
        setAuthState('not-authorized');
      }
    }
  }, []);

  useEffect(() => {
    adminSupabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) checkAuthorized();
      else setAuthState('signed-out');
    });
    const { data: sub } = adminSupabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession) checkAuthorized();
      else setAuthState('signed-out');
    });
    return () => sub.subscription.unsubscribe();
  }, [checkAuthorized]);

  async function signIn() {
    await adminSupabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/admin.html` },
    });
  }

  async function signOut() {
    await adminSupabase.auth.signOut();
    setAuthState('signed-out');
  }

  function goDashboard() {
    setView('dashboard');
  }
  function goListings(filters: ListingFilters = {}) {
    setListingsFilters(filters);
    setNavKey((k) => k + 1);
    setView('listings');
  }
  function goReports() {
    setView('reports');
  }
  function goAudit(filters: AuditLogFilters = {}) {
    setAuditFilters(filters);
    setNavKey((k) => k + 1);
    setView('audit');
  }
  function openListing(id: string) {
    setSelectedListingId(id);
    setView('listing-detail');
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
        <p>Sign in with the admin Google account to continue.</p>
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
        <p>This account isn't authorized to view admin data.</p>
        <button className="admin-button admin-button-secondary" onClick={signOut}>
          Sign out
        </button>
      </div>
    );
  }

  const adminEmail = session?.user.email ?? '';

  return (
    <div className="admin-shell">
      <div className="admin-header">
        <h1>Beggars Map — Admin</h1>
        <button className="admin-button admin-button-secondary" onClick={signOut}>
          Sign out ({adminEmail})
        </button>
      </div>

      <nav className="admin-nav">
        <button className={`admin-nav-tab ${view === 'dashboard' ? 'admin-nav-tab-active' : ''}`} onClick={goDashboard}>
          Dashboard
        </button>
        <button
          className={`admin-nav-tab ${view === 'listings' || view === 'listing-detail' ? 'admin-nav-tab-active' : ''}`}
          onClick={() => goListings({})}
        >
          Listings
        </button>
        <button className={`admin-nav-tab ${view === 'reports' ? 'admin-nav-tab-active' : ''}`} onClick={goReports}>
          Reports
        </button>
        <button className={`admin-nav-tab ${view === 'audit' ? 'admin-nav-tab-active' : ''}`} onClick={() => goAudit({})}>
          Audit Log
        </button>
      </nav>

      <div className="admin-view">
        {view === 'dashboard' ? (
          <Dashboard onNavigateReports={goReports} onNavigateListings={goListings} onNavigateAudit={() => goAudit({})} />
        ) : null}

        {view === 'listings' ? <ListingsList key={navKey} initialFilters={listingsFilters} onOpenListing={openListing} /> : null}

        {view === 'listing-detail' && selectedListingId ? (
          <ListingDetail listingId={selectedListingId} onBack={() => setView('listings')} />
        ) : null}

        {view === 'reports' ? (
          <ReportsQueue adminEmail={adminEmail} onViewHistory={(listingId) => goAudit({ targetId: listingId })} />
        ) : null}

        {view === 'audit' ? <AuditLog key={navKey} initialFilters={auditFilters} onOpenListing={openListing} /> : null}
      </div>
    </div>
  );
}
