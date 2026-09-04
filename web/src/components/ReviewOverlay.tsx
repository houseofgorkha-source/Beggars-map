import { useEffect } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  listingName: string;
  review: string;
  rating: number | null;
  onClose: () => void;
};

// Reads a listing's review (listings.note) in full, opened by the "Review"
// link on the list card and the map popup's compact card.
//
// Portalled onto document.body for exactly the same reason PhotoLightbox is
// (see that file's header): the compact card lives inside the map's popup
// anchor at z-index 3, deliberately BELOW the list panel at z-index 4, so
// anything rendered inside that subtree inherits the same ceiling and opens
// underneath the list. Portalling sidesteps the stacking context rather
// than renegotiating z-index values that other things already depend on.
//
// This exists so the cards themselves don't have to grow: the review stays
// clamped in place on the card (unchanged) and the full text is read here.
export default function ReviewOverlay({ listingName, review, rating, onClose }: Props) {
  useEffect(() => {
    // Capture phase + stopPropagation, matching PhotoLightbox: the search
    // input has its own Escape handler that clears an active search, and
    // that must not also fire when a review happens to be open on top.
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div className="review-overlay" onClick={onClose} role="dialog" aria-label={`Review of ${listingName}`}>
      <div className="review-overlay-card" onClick={(e) => e.stopPropagation()}>
        <div className="review-overlay-head">
          <span className="review-overlay-name">{listingName}</span>
          {rating != null ? (
            <span className="review-overlay-rating" aria-label={`Rated ${rating} out of 5`}>
              {'★'.repeat(rating)}
              {'☆'.repeat(5 - rating)}
            </span>
          ) : null}
        </div>
        <p className="review-overlay-text">{review}</p>
        <button className="review-overlay-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>,
    document.body
  );
}
