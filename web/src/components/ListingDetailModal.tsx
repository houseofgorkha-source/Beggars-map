import { forwardRef, useEffect, useRef, useState } from 'react';
import { supabase, ensureAnonymousSession } from '../lib/supabase';
import { formatRelativeTime } from '../lib/relativeTime';
import type { Listing } from '../types';

type Props = {
  listingId: string;
  onClose: () => void;
  onUpdated?: () => void;
  // Mobile-web's "tiny complete card" layout — same data/handlers as the
  // desktop card below, just a wholly different (much smaller) render path.
  // Never true on desktop/tablet — see the `isMobile` gate in App.tsx.
  compact?: boolean;
};

const REPORT_REASONS = ["Closed / doesn't exist", 'Wrong price', 'Inappropriate photo', 'Spam or duplicate'];

function DirectionsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="3 11 22 2 13 21 11 13 3 11" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

// Forwards a ref to the root `.listing-cover` element so App.tsx can play a
// "this card flew up from its spot in the list" animation (a FLIP: capture
// the clicked list-card's position, then transform this element from that
// position back to `translate(0)`) — see the effect around `flyFromTop` in
// App.tsx. The same ref is also what App.tsx's mobile sheet measures (via
// ResizeObserver) to size the collapsed "map mode" sheet height around the
// compact card's real rendered content.
const ListingDetailModal = forwardRef<HTMLDivElement, Props>(function ListingDetailModal(
  { listingId, onClose, onUpdated, compact },
  ref
) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [voteCount, setVoteCount] = useState(0);
  const [hasVoted, setHasVoted] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const reportWrapRef = useRef<HTMLDivElement>(null);

  async function load() {
    // None of these depend on each other's results, so run them concurrently
    // instead of one round-trip after another.
    const [{ data: listingData, error: listingError }, { count }, userId] = await Promise.all([
      supabase.from('listings').select('*').eq('id', listingId).maybeSingle(),
      supabase.from('votes').select('*', { count: 'exact', head: true }).eq('listing_id', listingId),
      ensureAnonymousSession(),
    ]);

    // A listing that's been deleted, or hidden by moderation (RLS filters it
    // out of public SELECT), comes back as no row rather than an error —
    // .maybeSingle() (not .single()) is what makes that "no row" case land
    // here as null instead of throwing, so we can tell it apart from "still
    // fetching" and show a real message instead of spinning forever.
    if (listingError || !listingData) {
      setNotFound(true);
      return;
    }

    setListing(listingData as Listing);
    setVoteCount(count ?? 0);
    setMyUserId(userId);

    if (userId) {
      const { data: myVote } = await supabase
        .from('votes')
        .select('listing_id')
        .eq('listing_id', listingId)
        .eq('created_by', userId)
        .maybeSingle();
      setHasVoted(!!myVote);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId]);

  // The compact card's report reasons render as a small floating popover
  // (not an inline-expanding panel — that would grow the card and force the
  // internal scrolling the compact layout is required not to have). Closes
  // on an outside tap, same pattern as the search-results dropdown in
  // App.tsx.
  useEffect(() => {
    if (!compact || !reporting) return;
    function handlePointerDown(e: MouseEvent) {
      if (reportWrapRef.current?.contains(e.target as Node)) return;
      setReporting(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [compact, reporting]);

  async function toggleVote() {
    const userId = await ensureAnonymousSession();
    if (!userId) return;

    if (hasVoted) {
      await supabase.from('votes').delete().eq('listing_id', listingId).eq('created_by', userId);
    } else {
      await supabase.from('votes').insert({ listing_id: listingId, created_by: userId });
    }
    load();
    onUpdated?.();
  }

  async function reportListing(reason: string) {
    const userId = await ensureAnonymousSession();
    if (!userId) {
      window.alert('Could not start a session. Please refresh and try again.');
      return;
    }
    const { error: reportError } = await supabase.from('reports').insert({ listing_id: listingId, reported_by: userId, reason });
    if (reportError) {
      if (reportError.code === '23505') {
        setReporting(false);
        window.alert("You've already reported this listing for that reason.");
        return;
      }
      window.alert(`Could not send report: ${reportError.message}`);
      return;
    }
    setReporting(false);
    window.alert('Thanks — this has been reported.');
  }

  async function deleteListing() {
    if (!listing) return;
    if (!window.confirm('Delete this listing? This removes it for everyone and cannot be undone.')) return;

    const { error } = await supabase.from('listings').delete().eq('id', listing.id);
    if (error) {
      window.alert(`Could not delete listing: ${error.message}`);
      return;
    }
    if (listing.photo_url) {
      const path = listing.photo_url.split('/listing-photos/')[1];
      if (path) await supabase.storage.from('listing-photos').remove([path]);
    }
    onUpdated?.();
    onClose();
  }

  function openDirections() {
    if (!listing) return;
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${listing.latitude},${listing.longitude}`, '_blank');
  }

  if (notFound) {
    return (
      <div className={`listing-cover${compact ? ' listing-cover-compact' : ''}`} ref={ref}>
        {compact ? (
          <div className="compact-top">
            <span className="compact-empty-text">This listing is no longer available.</span>
            <button className="compact-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        ) : (
          <>
            <div className="modal-header">
              <h2>Not available</h2>
              <button className="icon-button" onClick={onClose} aria-label="Close">✕</button>
            </div>
            <p className="loading-text">This listing is no longer available.</p>
          </>
        )}
      </div>
    );
  }

  if (!listing) {
    return (
      <div className={`listing-cover${compact ? ' listing-cover-compact' : ''}`} ref={ref}>
        <p className={compact ? 'compact-empty-text' : 'loading-text'}>Loading…</p>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="listing-cover listing-cover-compact" ref={ref}>
        <div className="compact-top">
          {listing.photo_url ? <img src={listing.photo_url} alt="" className="compact-thumb" /> : null}
          <div className="compact-top-text">
            <div className="compact-title-row">
              <span className="compact-title">{listing.name}</span>
              <span className="compact-price">₹{listing.price_rupees}</span>
            </div>
            {listing.note ? <p className="compact-note">{listing.note}</p> : null}
          </div>
          <button className="compact-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="compact-footer">
          <span className="compact-posted">{formatRelativeTime(listing.created_at)}</span>
          <div className="compact-actions">
            <button className={`compact-vote ${hasVoted ? 'active' : ''}`} onClick={toggleVote} aria-label="Worth it">
              ▲ {voteCount}
            </button>
            <button className="compact-icon-button" onClick={openDirections} aria-label="Directions">
              <DirectionsIcon />
            </button>
            <div className="compact-report-wrap" ref={reportWrapRef}>
              <button
                className="compact-icon-button compact-report-trigger"
                onClick={() => setReporting((r) => !r)}
                aria-label="Report"
              >
                <FlagIcon />
              </button>
              {reporting ? (
                <div className="compact-report-popover">
                  {REPORT_REASONS.map((reason) => (
                    <button key={reason} className="compact-report-reason" onClick={() => reportListing(reason)}>
                      {reason}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {myUserId && listing.created_by === myUserId ? (
              <button className="compact-icon-button compact-delete" onClick={deleteListing} aria-label="Delete my listing">
                <TrashIcon />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="listing-cover" ref={ref}>
        <div className="modal-header">
          <h2>{listing.name}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body">
          {listing.photo_url ? <img src={listing.photo_url} alt={listing.name} className="detail-photo" /> : null}

          <div className="detail-price-row">
            <span className="detail-price">₹{listing.price_rupees}</span>
            {listing.note ? <span className="detail-note">{listing.note}</span> : null}
          </div>
          <span className="detail-posted">Posted {formatRelativeTime(listing.created_at)}</span>

          <div className="detail-actions">
            <button className={`vote-button ${hasVoted ? 'active' : ''}`} onClick={toggleVote}>
              ▲ Worth it ({voteCount})
            </button>
            <button className="secondary-button" onClick={openDirections}>Directions</button>
            <button className="report-button" onClick={() => setReporting(true)}>Report</button>
          </div>

          {myUserId && listing.created_by === myUserId ? (
            <button className="text-button delete-listing-button" onClick={deleteListing}>Delete my listing</button>
          ) : null}

          {reporting ? (
            <div className="report-panel">
              {REPORT_REASONS.map((reason) => (
                <button key={reason} className="secondary-button" onClick={() => reportListing(reason)}>
                  {reason}
                </button>
              ))}
              <button className="text-button" onClick={() => setReporting(false)}>Cancel</button>
            </div>
          ) : null}
        </div>
    </div>
  );
});

export default ListingDetailModal;
