import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, ensureAnonymousSession, PUBLIC_LISTING_COLUMNS } from '../lib/supabase';
import { formatRelativeTime } from '../lib/relativeTime';
import PhotoLightbox from './PhotoLightbox';
import type { Listing, ListingPhoto } from '../types';

type Props = {
  listingId: string;
  onClose: () => void;
  onUpdated?: () => void;
  // The tiny complete card layout — same data/handlers as the desktop card
  // below, just a wholly different (much smaller) render path. Used for
  // portrait mobile's bottom-sheet card (gated by `isMobilePortrait` in
  // App.tsx) AND, on every other viewport, as the content of the map's own
  // marker popup (see MapView.tsx) — the same compact card either way, just
  // hosted in two different containers.
  compact?: boolean;
  // Distance from the user's own location, in km — computed by the caller
  // (App.tsx, from navigator.geolocation) since this component only knows
  // its own listingId, not the viewer's position. null/undefined (no
  // location permission, or not passed at all) simply omits it, same as
  // native mobile's own graceful fallback.
  distanceKm?: number | null;
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
  { listingId, onClose, onUpdated, compact, distanceKm },
  ref
) {
  const [listing, setListing] = useState<Listing | null>(null);
  // Photos 2..n live in `listing_photos` (migration 0009); photo 1 is
  // duplicated onto `listings.photo_url` so single-photo consumers keep
  // working untouched. See `photos` below for how the two are merged.
  const [extraPhotos, setExtraPhotos] = useState<ListingPhoto[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [voteCount, setVoteCount] = useState(0);
  const [hasVoted, setHasVoted] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reportFeedback, setReportFeedback] = useState<string | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const reportWrapRef = useRef<HTMLDivElement>(null);

  async function load() {
    // None of these depend on each other's results, so run them concurrently
    // instead of one round-trip after another.
    const [{ data: listingData, error: listingError }, { count }, photoResult, userId] = await Promise.all([
      supabase.from('listings').select(PUBLIC_LISTING_COLUMNS).eq('id', listingId).maybeSingle(),
      supabase.from('votes').select('*', { count: 'exact', head: true }).eq('listing_id', listingId),
      supabase.from('listing_photos').select('*').eq('listing_id', listingId).order('position', { ascending: true }),
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
    // Deliberately non-fatal: `listing_photos` is not present in every
    // environment (it is missing from production as of this writing, where
    // the request comes back as an error rather than an empty list). A
    // listing that can't load its extra photos still shows its primary
    // photo and everything else, exactly as it did before this existed.
    setExtraPhotos((photoResult.error ? [] : (photoResult.data as ListingPhoto[] | null)) ?? []);
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

  // Every photo belonging to this listing, in display order: the primary
  // `photo_url` first (so the existing "photo 1 is the cover" behaviour is
  // unchanged), then the rest of `listing_photos`. Deduplicated by URL
  // because photo 1 legitimately appears in BOTH places — AddListingModal
  // and the Excel importer each write it to `photo_url` AND as position 0 —
  // and without this the viewer would show the cover photo twice.
  const photos = useMemo(() => {
    const urls: string[] = [];
    if (listing?.photo_url) urls.push(listing.photo_url);
    for (const photo of extraPhotos) {
      if (photo.photo_url && !urls.includes(photo.photo_url)) urls.push(photo.photo_url);
    }
    return urls;
  }, [listing?.photo_url, extraPhotos]);

  // A listing whose photos changed underneath an open viewer (or which had
  // none to begin with) must not leave the viewer pointing at nothing.
  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= photos.length) setLightboxIndex(null);
  }, [photos, lightboxIndex]);

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
      setReportFeedback('Could not start a session. Please refresh and try again.');
      return;
    }
    const { error: reportError } = await supabase.from('reports').insert({ listing_id: listingId, reported_by: userId, reason });
    if (reportError) {
      if (reportError.code === '23505') {
        setReportFeedback("You've already reported this listing for that reason.");
        return;
      }
      setReportFeedback(`Could not send report: ${reportError.message}`);
      return;
    }
    // Shown inline rather than via window.alert — a blocking native dialog
    // is easy to miss (and gets silently no-op'd in some embedded/webview
    // browser contexts), which read as "nothing happens" when reporting.
    setReportFeedback('Thanks — this has been reported.');
    setTimeout(() => {
      setReporting(false);
      setReportFeedback(null);
    }, 1800);
  }

  function toggleReporting() {
    setReporting((r) => !r);
    setReportFeedback(null);
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
          {photos.length ? (
            <button
              type="button"
              className="compact-thumb-button"
              // The compact card is hosted inside the map's marker popup;
              // a click here must not bubble out to the map/marker handlers
              // underneath it.
              onClick={(e) => {
                e.stopPropagation();
                setLightboxIndex(0);
              }}
              aria-label={photos.length > 1 ? `View all ${photos.length} photos` : 'View photo'}
              title={photos.length > 1 ? `View all ${photos.length} photos` : 'View photo'}
            >
              <img src={photos[0]} alt="" className="compact-thumb" />
              {photos.length > 1 ? <span className="photo-count-badge">{photos.length}</span> : null}
            </button>
          ) : null}
          <div className="compact-top-text">
            <div className="compact-title-row">
              <span className="compact-title">{listing.name}</span>
              <span className="compact-price">₹{listing.price_rupees}</span>
            </div>
            {listing.note ? <p className="compact-note">{listing.note}</p> : null}
            {listing.location_label ? <p className="compact-location">{listing.location_label}</p> : null}
          </div>
          <button className="compact-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="compact-footer">
          <span className="compact-meta">
            <span className="compact-posted">{formatRelativeTime(listing.created_at)}</span>
            {distanceKm != null ? <span className="compact-distance">{distanceKm.toFixed(1)} km away</span> : null}
          </span>
          <div className="compact-actions">
            <button className={`compact-vote ${hasVoted ? 'active' : ''}`} onClick={toggleVote} aria-label="Worth it">
              ▲ {voteCount}
            </button>
            <button className="compact-icon-button" onClick={openDirections} aria-label="Directions" title="Directions">
              <DirectionsIcon />
            </button>
            <div className="compact-report-wrap" ref={reportWrapRef}>
              <button
                className="compact-icon-button compact-report-trigger"
                onClick={toggleReporting}
                aria-label="Report"
                title="Report"
              >
                <FlagIcon />
              </button>
              {reporting ? (
                <div className="compact-report-popover">
                  {reportFeedback ? (
                    <p className="compact-report-feedback">{reportFeedback}</p>
                  ) : (
                    REPORT_REASONS.map((reason) => (
                      <button key={reason} className="compact-report-reason" onClick={() => reportListing(reason)}>
                        {reason}
                      </button>
                    ))
                  )}
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

        {lightboxIndex !== null ? (
          <PhotoLightbox
            photos={photos}
            startIndex={lightboxIndex}
            listingName={listing.name}
            onClose={() => setLightboxIndex(null)}
          />
        ) : null}
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
          {photos.length ? (
            <button
              type="button"
              className="detail-photo-button"
              onClick={() => setLightboxIndex(0)}
              aria-label={photos.length > 1 ? `View all ${photos.length} photos` : 'View photo'}
              title={photos.length > 1 ? `View all ${photos.length} photos` : 'View photo'}
            >
              <img src={photos[0]} alt={listing.name} className="detail-photo" />
              {photos.length > 1 ? <span className="photo-count-badge">{photos.length}</span> : null}
            </button>
          ) : null}

          <div className="detail-price-row">
            <span className="detail-price">₹{listing.price_rupees}</span>
            {listing.note ? <span className="detail-note">{listing.note}</span> : null}
          </div>
          <span className="detail-posted">Posted {formatRelativeTime(listing.created_at)}</span>

          <div className="detail-actions">
            <button className={`vote-button ${hasVoted ? 'active' : ''}`} onClick={toggleVote}>
              ▲ Worth it ({voteCount})
            </button>
            <button className="secondary-button" onClick={openDirections} title="Directions">Directions</button>
            <button className="report-button" onClick={() => { setReporting(true); setReportFeedback(null); }} title="Report">Report</button>
          </div>

          {myUserId && listing.created_by === myUserId ? (
            <button className="text-button delete-listing-button" onClick={deleteListing}>Delete my listing</button>
          ) : null}

          {reporting ? (
            <div className="report-panel">
              {reportFeedback ? (
                <p className="report-feedback">{reportFeedback}</p>
              ) : (
                REPORT_REASONS.map((reason) => (
                  <button key={reason} className="secondary-button" onClick={() => reportListing(reason)}>
                    {reason}
                  </button>
                ))
              )}
              <button className="text-button" onClick={() => setReporting(false)}>Cancel</button>
            </div>
          ) : null}
        </div>

        {lightboxIndex !== null ? (
          <PhotoLightbox
            photos={photos}
            startIndex={lightboxIndex}
            listingName={listing.name}
            onClose={() => setLightboxIndex(null)}
          />
        ) : null}
    </div>
  );
});

export default ListingDetailModal;
