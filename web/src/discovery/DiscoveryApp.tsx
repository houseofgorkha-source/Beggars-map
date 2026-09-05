import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { discoverySupabase } from './discoverySupabase';
import { discoveryApi, Candidate, isReviewed } from './lib/discoveryApi';
import CandidateList, { CandidateFilter } from './views/CandidateList';
import CandidateDetail from './views/CandidateDetail';

type AuthState = 'checking' | 'signed-out' | 'not-authorized' | 'authorized';

export default function DiscoveryApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [authState, setAuthState] = useState<AuthState>('checking');

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [filter, setFilter] = useState<CandidateFilter>('all');
  const [search, setSearch] = useState('');
  const [dirty, setDirty] = useState(false);

  const checkAuthorized = useCallback(async () => {
    // A real check that the caller's email is on DISCOVERY_EMAILS happens
    // server-side on every Edge Function call — this is only a UI gate to
    // avoid flashing the workbench before we know. Any failure (403, or
    // anything else) fails closed to not-authorized, same as AdminApp.tsx.
    try {
      await discoveryApi.list();
      setAuthState('authorized');
    } catch {
      setAuthState('not-authorized');
    }
  }, []);

  useEffect(() => {
    discoverySupabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) checkAuthorized();
      else setAuthState('signed-out');
    });
    const { data: sub } = discoverySupabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession) checkAuthorized();
      else setAuthState('signed-out');
    });
    return () => sub.subscription.unsubscribe();
  }, [checkAuthorized]);

  const loadCandidates = useCallback(async () => {
    setLoadingCandidates(true);
    setLoadError(null);
    try {
      const res = await discoveryApi.list();
      setCandidates(res.data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load candidates.');
    } finally {
      setLoadingCandidates(false);
    }
  }, []);

  useEffect(() => {
    if (authState === 'authorized') loadCandidates();
  }, [authState, loadCandidates]);

  // Warns on a real tab close/refresh while an edit is unsaved. In-app
  // navigation (Prev/Next/selecting a row) is guarded separately below via
  // window.confirm, since beforeunload can't intercept a same-page action.
  useEffect(() => {
    if (!dirty) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  async function signIn() {
    await discoverySupabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/discovery.html` },
    });
  }

  async function signOut() {
    await discoverySupabase.auth.signOut();
    setAuthState('signed-out');
  }

  function updateCandidateLocally(updated: Candidate) {
    setCandidates((prev) => prev.map((c) => (c.place_id === updated.place_id ? updated : c)));
  }

  function guardedSelect(placeId: string) {
    if (dirty && !window.confirm('You have unsaved changes. Discard them?')) return;
    setSelectedPlaceId(placeId);
  }

  // Cycles to the next/previous UNREVIEWED candidate in full list order
  // (not the currently-filtered/searched view) — any row is still directly
  // clickable from the list regardless. Falls back to the adjacent row if
  // nothing unreviewed remains.
  function selectAdjacentUnreviewed(direction: 1 | -1) {
    if (candidates.length === 0) return;
    const currentIndex = selectedPlaceId ? candidates.findIndex((c) => c.place_id === selectedPlaceId) : -1;
    let i = currentIndex;
    for (let step = 0; step < candidates.length; step++) {
      i = (i + direction + candidates.length) % candidates.length;
      if (!isReviewed(candidates[i])) {
        setSelectedPlaceId(candidates[i].place_id);
        return;
      }
    }
    const fallback = (currentIndex + direction + candidates.length) % candidates.length;
    setSelectedPlaceId(candidates[fallback]?.place_id ?? null);
  }

  if (authState === 'checking') {
    return (
      <div className="discovery-shell-message">
        <p>Loading…</p>
      </div>
    );
  }

  if (authState === 'signed-out') {
    return (
      <div className="discovery-shell-message">
        <h1>Beggars Map — Discovery Workbench</h1>
        <p>Sign in with your Google account to continue.</p>
        <button className="admin-button" onClick={signIn}>
          Sign in with Google
        </button>
      </div>
    );
  }

  if (authState === 'not-authorized') {
    return (
      <div className="discovery-shell-message">
        <h1>Beggars Map — Discovery Workbench</h1>
        <p>This account isn't authorized to review candidates.</p>
        <button className="admin-button admin-button-secondary" onClick={signOut}>
          Sign out
        </button>
      </div>
    );
  }

  const reviewedCount = candidates.filter(isReviewed).length;
  const filtered = candidates.filter((c) => {
    if (filter === 'reviewed' && !isReviewed(c)) return false;
    if (filter === 'unreviewed' && isReviewed(c)) return false;
    if (filter === 'no-answer' && c.number_valid !== 'No Answer') return false;
    if (search.trim() && !c.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  });
  const selected = candidates.find((c) => c.place_id === selectedPlaceId) ?? null;

  return (
    <div className="discovery-shell">
      <div className="admin-header">
        <div>
          <h1>Discovery Workbench</h1>
          <p className="admin-muted">
            {candidates.length === 0 ? 'No active batch' : `${reviewedCount} / ${candidates.length} reviewed in this batch`}
          </p>
        </div>
        <button className="admin-button admin-button-secondary" onClick={signOut}>
          Sign out ({session?.user.email ?? ''})
        </button>
      </div>

      {loadError ? <p className="admin-error">{loadError}</p> : null}

      {loadingCandidates ? (
        <p className="admin-muted">Loading…</p>
      ) : candidates.length === 0 ? (
        <p className="admin-muted">No active batch right now — check back once one is pushed.</p>
      ) : (
        <div className="discovery-body">
          <CandidateList
            candidates={filtered}
            selectedPlaceId={selectedPlaceId}
            onSelect={guardedSelect}
            filter={filter}
            onFilterChange={setFilter}
            search={search}
            onSearchChange={setSearch}
          />
          {selected ? (
            <CandidateDetail
              key={selected.place_id}
              candidate={selected}
              onSaved={updateCandidateLocally}
              onDirtyChange={setDirty}
              onPrev={() => selectAdjacentUnreviewed(-1)}
              onNext={() => selectAdjacentUnreviewed(1)}
            />
          ) : (
            <div className="discovery-detail-empty">Select a candidate to begin.</div>
          )}
        </div>
      )}
    </div>
  );
}
