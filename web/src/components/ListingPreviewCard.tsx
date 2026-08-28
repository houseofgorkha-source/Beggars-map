import type { Listing } from '../types';
import { formatRelativeTime } from '../lib/relativeTime';

type Props = {
  listing: Listing & { voteCount: number };
  onClose: () => void;
  onViewDetails: () => void;
};

// Mobile-web only (see App.tsx's selectListing) — a lean, no-network preview
// so tapping a pin/list-card reads as instant instead of jumping straight
// into the full ListingDetailModal (photo, directions, report). Only reads
// data App.tsx already has loaded, no fetch of its own.
export default function ListingPreviewCard({ listing, onClose, onViewDetails }: Props) {
  return (
    <div className="listing-preview-card" onClick={onViewDetails}>
      <button
        className="icon-button listing-preview-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close preview"
      >
        ✕
      </button>
      <div className="listing-preview-header">
        <span className="listing-preview-name">{listing.name}</span>
        <span className="listing-preview-price">₹{listing.price_rupees}</span>
      </div>
      {listing.note ? <p className="listing-preview-note">{listing.note}</p> : null}
      <div className="listing-preview-meta">
        <span className="listing-preview-votes">▲ Worth it ({listing.voteCount})</span>
        <span className="listing-preview-posted">{formatRelativeTime(listing.created_at)}</span>
      </div>
      <span className="listing-preview-hint">Tap for full details</span>
    </div>
  );
}
