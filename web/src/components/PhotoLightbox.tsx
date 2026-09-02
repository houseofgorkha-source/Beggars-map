import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  photos: string[];
  startIndex: number;
  listingName: string;
  onClose: () => void;
};

// Full-screen photo viewer for a single listing's photos.
//
// Rendered through a portal onto document.body rather than inside the card
// that opened it. That is not a style choice: the compact card lives inside
// the map's own popup anchor (`.map-popup-anchor`, z-index 3), which sits
// DELIBERATELY below the list panel (z-index 4) — see the popup notes in
// AGENTS.md, and the warning there about why raising the list panel to fix
// an overlap cascades into unrelated breakage. A lightbox rendered inside
// that subtree would inherit the same ceiling and open underneath the list.
// Portalling to body sidesteps the whole stacking context instead of
// renegotiating it, so nothing about the existing z-index order changes.
export default function PhotoLightbox({ photos, startIndex, listingName, onClose }: Props) {
  const [index, setIndex] = useState(startIndex);
  const touchStartX = useRef<number | null>(null);

  const count = photos.length;
  const go = useCallback(
    (delta: number) => {
      // Wraps, so the arrows never dead-end on the first/last photo.
      setIndex((current) => (current + delta + count) % count);
    },
    [count]
  );

  useEffect(() => {
    setIndex(startIndex);
  }, [startIndex, photos]);

  useEffect(() => {
    // Capture phase + stopPropagation so Escape closes the viewer and
    // nothing else: the search input has its own Escape handler that fully
    // clears a search, and that must not also fire when a photo happens to
    // be open on top of it.
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowRight' && count > 1) {
        e.stopPropagation();
        go(1);
      } else if (e.key === 'ArrowLeft' && count > 1) {
        e.stopPropagation();
        go(-1);
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [go, count, onClose]);

  useEffect(() => {
    // The page behind must not scroll while a full-screen viewer is open.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (count === 0) return null;

  return createPortal(
    <div
      className="photo-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Photos of ${listingName}`}
      onClick={onClose}
    >
      <button className="photo-lightbox-close" onClick={onClose} aria-label="Close photo viewer">
        ✕
      </button>

      {count > 1 ? (
        <button
          className="photo-lightbox-nav photo-lightbox-prev"
          onClick={(e) => {
            e.stopPropagation();
            go(-1);
          }}
          aria-label="Previous photo"
        >
          ‹
        </button>
      ) : null}

      <img
        className="photo-lightbox-image"
        src={photos[index]}
        alt={`${listingName} photo ${index + 1} of ${count}`}
        // The backdrop closes on click; the photo itself must not.
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => {
          touchStartX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          if (touchStartX.current === null || count < 2) return;
          const delta = (e.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
          // Same "deliberate swipe, not a stray tap" threshold idea the
          // mobile sheet drag uses — small enough to feel responsive,
          // large enough that a tap can't trigger it.
          if (Math.abs(delta) > 40) go(delta < 0 ? 1 : -1);
          touchStartX.current = null;
        }}
      />

      {count > 1 ? (
        <button
          className="photo-lightbox-nav photo-lightbox-next"
          onClick={(e) => {
            e.stopPropagation();
            go(1);
          }}
          aria-label="Next photo"
        >
          ›
        </button>
      ) : null}

      {count > 1 ? (
        <div className="photo-lightbox-counter" onClick={(e) => e.stopPropagation()}>
          {index + 1} / {count}
        </div>
      ) : null}
    </div>,
    document.body
  );
}
