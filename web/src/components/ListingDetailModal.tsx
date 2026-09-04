import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, ensureAnonymousSession } from '../lib/supabase';
import { fetchListing, fetchVoteCount, hasUserVoted, toggleVote as toggleVoteRequest, reportListing as reportListingRequest, deleteListing as deleteListingRequest } from '../lib/listings';
import { formatRelativeTime } from '../lib/relativeTime';
import PhotoLightbox from './PhotoLightbox';
import ReviewOverlay from './ReviewOverlay';
import { parseDishes, formatDishes } from '../lib/dishes';
import type { Listing, ListingPhoto } from '../types';

type Props = {
  listingId: string;
  onClose: () => void;
  onUpdated?: () => void;
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

// The tiny complete card layout — used for portrait mobile's bottom-sheet
// card (gated by `isMobilePortrait` in App.tsx) AND, on every other
// viewport, as the content of the map's own marker popup (see MapView.tsx)
// — the same card either way, just hosted in two different containers.
// This used to also have a second, larger non-compact render path (a
// `compact` prop toggled between them); that branch was verified
// unreachable (every real call site always passed `compact`) and removed
// — see CTO-audit cleanup item G / remediation plan P7.
//
// Forwards a ref to the root `.listing-cover` element so App.tsx can play a
// "this card flew up from its spot in the list" animation (a FLIP: capture
// the clicked list-card's position, then transform this element from that
// position back to `translate(0)`) — see the effect around `flyFromTop` in
// App.tsx. The same ref is also what App.tsx's mobile sheet measures (via
// ResizeObserver) to size the collapsed "map mode" sheet height around the
// compact card's real rendered content.
const ListingDetailModal = forwardRef<HTMLDivElement, Props>(function ListingDetailModal(
  { listingId, onClose, onUpdated, distanceKm },
  ref
) {
  const [listing, setListing] = useState<Listing | null>(null);
  // Photos 2..n live in `listing_photos` (migration 0009); photo 1 is
  // duplicated onto `listings.photo_url` so single-photo consumers keep
  // working untouched. See `photos` below for how the two are merged.
  const [extraPhotos, setExtraPhotos] = useState<ListingPhoto[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showReview, setShowReview] = useState(false);
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
    const [listingResult, voteCount, photoResult, userId] = await Promise.all([
      fetchListing(listingId),
      fetchVoteCount(listingId),
      supabase.from('listing_photos').select('*').eq('listing_id', listingId).order('position', { ascending: true }),
      ensureAnonymousSession(),
    ]);

    // A listing that's been deleted, or hidden by moderation (RLS filters it
    // out of public SELECT), comes back as no row rather than an error —
    // fetchListing's `notFound` case is what makes that land here as null
    // instead of throwing, so we can tell it apart from "still fetching"
    // and show a real message instead of spinning forever.
    if ('error' in listingResult || !listingResult.data) {
      setNotFound(true);
      return;
    }

    setListing(listingResult.data);
    // Deliberately non-fatal: `listing_photos` is not present in every
    // environment (it is missing from production as of this writing, where
    // the request comes back as an error rather than an empty list). A
    // listing that can't load its extra photos still shows its primary
    // photo and everything else, exactly as it did before this existed.
    setExtraPhotos((photoResult.error ? [] : (photoResult.data as ListingPhoto[] | null)) ?? []);
    setVoteCount(voteCount);
    setMyUserId(userId);

    if (userId) {
      setHasVoted(await hasUserVoted(listingId, userId));
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

  // Plain-language rendering of the structured dish entries, derived here
  // and never persisted — the stored array stays the single source of truth.
  // Empty string for any listing without dishes (everything created before
  // 0020), which the render below treats as "fall back to today's display".
  const dishText = useMemo(() => formatDishes(parseDishes(listing?.dishes)), [listing?.dishes]);

  // A listing whose photos changed underneath an open viewer (or which had
  // none to begin with) must not leave the viewer pointing at nothing.
  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= photos.length) setLightboxIndex(null);
  }, [photos, lightboxIndex]);

  // The report reasons render as a small floating popover (not an
  // inline-expanding panel — that would grow the card and force the
  // internal scrolling this compact layout is required not to have).
  // Closes on an outside tap, same pattern as the search-results dropdown
  // in App.tsx.
  useEffect(() => {
    if (!reporting) return;
    function handlePointerDown(e: MouseEvent) {
      if (reportWrapRef.current?.contains(e.target as Node)) return;
      setReporting(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [reporting]);

  async function toggleVote() {
    const userId = await ensureAnonymousSession();
    if (!userId) return;

    await toggleVoteRequest(listingId, userId, hasVoted);
    load();
    onUpdated?.();
  }

  async function reportListing(reason: string) {
    const userId = await ensureAnonymousSession();
    if (!userId) {
      setReportFeedback('Could not start a session. Please refresh and try again.');
      return;
    }
    const result = await reportListingRequest(listingId, userId, reason);
    if ('error' in result) {
      setReportFeedback(result.error);
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

    const result = await deleteListingRequest(listing.id);
    if ('error' in result) {
      window.alert(`Could not delete listing: ${result.error}`);
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
      <div className="listing-cover listing-cover-compact" ref={ref}>
        <div className="compact-top">
          <span className="compact-empty-text">This listing is no longer available.</span>
          <button className="compact-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="listing-cover listing-cover-compact" ref={ref}>
        <p className="compact-empty-text">Loading…</p>
      </div>
    );
  }

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
          {/* Dishes are the primary content here, rendered as a plain
              sentence derived from the structured entries — never a table,
              and never stored pre-formatted (see lib/dishes.ts). A listing
              created before 0020 has no dish breakdown, so this slot keeps
              showing exactly what it shows today (the note), which is what
              makes every pre-existing listing render unchanged. */}
          {dishText ? (
            <p className="compact-note">{dishText}</p>
          ) : listing.note ? (
            <p className="compact-note">{listing.note}</p>
          ) : null}
          {listing.location_label ? <p className="compact-location">{listing.location_label}</p> : null}
        </div>
        <button className="compact-close" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="compact-footer">
        <span className="compact-meta">
          <span className="compact-posted">{formatRelativeTime(listing.created_at)}</span>
          {/* Added into the existing inline meta row, not as new rows, so
              the popup card keeps its current height and shape. Both are
              omitted when the listing has neither. */}
          {listing.rating != null ? (
            <span className="compact-rating" aria-label={`Rated ${listing.rating} out of 5`}>
              {'★'.repeat(listing.rating)}
            </span>
          ) : null}
          {listing.note ? (
            <button
              className="compact-review-link"
              onClick={(e) => {
                // This card sits inside the map's marker popup — a click
                // must not bubble out to the map/marker handlers beneath.
                e.stopPropagation();
                setShowReview(true);
              }}
            >
              Review
            </button>
          ) : null}
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

      {showReview && listing.note ? (
        <ReviewOverlay
          listingName={listing.name}
          review={listing.note}
          rating={listing.rating}
          onClose={() => setShowReview(false)}
        />
      ) : null}
    </div>
  );
});

export default ListingDetailModal;
