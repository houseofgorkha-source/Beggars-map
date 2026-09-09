import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase, ensureAnonymousSession } from '../lib/supabase';
import {
  fetchListingReviews,
  fetchMyReview,
  submitListingReview,
  validateReviewDraft,
  REVIEW_TEXT_MAX_LENGTH,
  MAX_REVIEW_PHOTOS,
} from '../lib/reviews';
import { submitNameCorrection, submitDishesCorrection, submitLocationCorrection } from '../lib/corrections';
import { checkFoodRelevance } from '../lib/contentModeration';
import { formatRelativeTime } from '../lib/relativeTime';
import { parseDishes, validateDishDrafts, dishEntriesToDrafts, type DishDraft, type DishEntry } from '../lib/dishes';
import { reverseGeocode } from '../lib/reverseGeocode';
import PhotoLightbox from './PhotoLightbox';
import DishPriceRows from './DishPriceRows';
import type { ListingReview } from '../types';

type Props = {
  listingId: string;
  listingName: string;
  // The listing's own creator's rating/note, set once at Add Listing time —
  // unchanged by anything in this file. Nullable: some listings have no
  // note at all, in which case priceRupees is the fallback "existing
  // content" (see the render below) — there is always at least a price to
  // show, never a blank "nothing here" state.
  review: string | null;
  rating: number | null;
  priceRupees: number;
  // Current canonical fields the read-first correction sections below
  // pre-fill themselves with and diff proposed edits against.
  dishes: unknown;
  latitude: number;
  longitude: number;
  // Both left undefined at the map-popup-triggered call site — the popup
  // has no access to App.tsx's picking-location machinery without touching
  // fragile, already-documented popup-unmount behavior outside this
  // feature's scope (see MapView.tsx's hidePopup). "Edit location" simply
  // doesn't render there; name/dishes editing still work.
  onPickOnMap?: (current: { lat: number; lon: number } | null, source?: 'manual' | 'current-location') => void;
  pickedLocation?: { lat: number; lon: number; token: number } | null;
  // True while the caller is mid-pick on the full-screen map — fades this
  // whole overlay out (opacity/pointer-events, same treatment as
  // AddListingModal's own `hidden`) rather than unmounting it, so every
  // section's in-progress edit state survives the round trip.
  hidden?: boolean;
  onClose: () => void;
};

// A read-first Review page: shows the listing's existing content (note or
// price, other users' reviews) up front, then three canonical fields
// (name/dishes/location) as read-only display + an "Edit X" toggle that
// reveals an inline editor with its own Save/Cancel — Save only stages the
// edit locally, it does not write anywhere. Rating/review text/photos stay
// directly editable throughout (they're the user's own new content, not a
// correction to preserve/compare against). ONE "Submit Review" button at
// the bottom sends everything at once:
//   - a changed name/dishes/location becomes its own listing_corrections
//     row (0023), pending admin approval — never a direct `listings` write
//     (there is no RLS path for the public client to do that at all).
//   - rating/review text/photos become an auto-published listing_reviews
//     upsert (0022), independent of whether any correction was submitted.
// An unchanged field (Save never clicked, or Saved back to the same value)
// submits no correction at all.
//
// Portalled onto document.body for exactly the same reason PhotoLightbox is
// (see that file's header): the compact card lives inside the map's popup
// anchor at z-index 3, deliberately BELOW the list panel at z-index 4, so
// anything rendered inside that subtree inherits the same ceiling and opens
// underneath the list. Portalling sidesteps the stacking context rather
// than renegotiating z-index values that other things already depend on.
export default function ReviewOverlay({
  listingId,
  listingName,
  review,
  rating,
  priceRupees,
  dishes,
  latitude,
  longitude,
  onPickOnMap,
  pickedLocation,
  hidden,
  onClose,
}: Props) {
  const canonicalDishes = useMemo(() => parseDishes(dishes), [dishes]);

  const [reviews, setReviews] = useState<ListingReview[]>([]);
  const [myReview, setMyReview] = useState<ListingReview | null>(null);
  const [loading, setLoading] = useState(true);
  // Rating/review-text below are seeded from myReview exactly ONCE, the
  // first time it loads — not on every load() re-run (e.g. after a
  // successful submit), which would otherwise clobber whatever the user
  // is actively typing.
  const myReviewSyncedRef = useRef(false);

  // Two-page flow within the same overlay: page 1 (default) is read-only —
  // the listing's existing content, other users' reviews, and one
  // Add/Edit Review button. Clicking it reveals page 2 — the editable
  // name/dishes/location sections plus rating/review/photos and Submit
  // Review. The header (listing name + close) is shared, unchanged, across
  // both.
  const [showContributePage, setShowContributePage] = useState(false);

  // ---- Restaurant name correction ----
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(listingName);
  // Staged (Saved) proposed value; null = no change proposed. Never written
  // anywhere until Submit Review.
  const [savedName, setSavedName] = useState<string | null>(null);
  const [nameEditError, setNameEditError] = useState<string | null>(null);

  // ---- Dishes & prices correction ----
  const [editingDishes, setEditingDishes] = useState(false);
  const [dishDraftRows, setDishDraftRows] = useState<DishDraft[]>(() => dishEntriesToDrafts(canonicalDishes));
  const [savedDishes, setSavedDishes] = useState<DishEntry[] | null>(null);
  const [dishEditError, setDishEditError] = useState<string | null>(null);

  // ---- Location correction ----
  const [editingLocation, setEditingLocation] = useState(false);
  // The in-flight pick, before Save — cleared when editing starts/ends.
  const [pickedCoords, setPickedCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [pickedLabel, setPickedLabel] = useState<string | null>(null);
  const [resolvingPickedLabel, setResolvingPickedLabel] = useState(false);
  const [savedCoords, setSavedCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [savedLocationLabel, setSavedLocationLabel] = useState<string | null>(null);

  // ---- Community content: rating, review text, photos — always editable ----
  const [myRating, setMyRating] = useState<number | null>(null);
  const [myReviewText, setMyReviewText] = useState('');
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const confirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [lightbox, setLightbox] = useState<{ photos: string[]; index: number } | null>(null);

  async function load() {
    setLoading(true);
    const [reviewsResult, userId] = await Promise.all([fetchListingReviews(listingId), ensureAnonymousSession()]);
    setReviews('error' in reviewsResult ? [] : reviewsResult.data);
    const mine = userId ? await fetchMyReview(listingId, userId) : null;
    setMyReview(mine);
    if (!myReviewSyncedRef.current) {
      setMyRating(mine?.rating ?? null);
      setMyReviewText(mine?.review_text ?? '');
      myReviewSyncedRef.current = true;
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId]);

  useEffect(() => {
    // Capture phase + stopPropagation, matching PhotoLightbox: the search
    // input has its own Escape handler that clears an active search, and
    // that must not also fire when this overlay happens to be open on top.
    // "Topmost layer closes first": a lightbox first, then any open inline
    // editor (cancelling it back to read-only), then page 2 back to page 1,
    // only then the whole overlay.
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (lightbox) return;
      if (editingName || editingDishes || editingLocation) {
        e.stopPropagation();
        setEditingName(false);
        setEditingDishes(false);
        setEditingLocation(false);
        setPickedCoords(null);
        return;
      }
      if (showContributePage) {
        e.stopPropagation();
        setShowContributePage(false);
        return;
      }
      e.stopPropagation();
      onClose();
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose, lightbox, editingName, editingDishes, editingLocation, showContributePage]);

  // Mirrors AddListingModal's own pickedLocation effect — keyed on the
  // token (not lat/lon) so re-picking the same spot still counts as a
  // fresh confirmation.
  useEffect(() => {
    if (!pickedLocation) return;
    setPickedCoords({ lat: pickedLocation.lat, lon: pickedLocation.lon });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedLocation?.token]);

  useEffect(() => {
    setPickedLabel(null);
    if (!pickedCoords) return;
    let cancelled = false;
    setResolvingPickedLabel(true);
    reverseGeocode(pickedCoords.lat, pickedCoords.lon).then((label) => {
      if (cancelled) return;
      setPickedLabel(label);
      setResolvingPickedLabel(false);
    });
    return () => {
      cancelled = true;
    };
  }, [pickedCoords]);

  // ---- Name section handlers ----
  function startEditName() {
    setNameInput(savedName ?? listingName);
    setNameEditError(null);
    setEditingName(true);
  }
  function saveName() {
    if (!nameInput.trim()) return setNameEditError('Enter a name.');
    setSavedName(nameInput.trim());
    setEditingName(false);
  }
  function cancelEditName() {
    setEditingName(false);
    setNameEditError(null);
  }

  // ---- Dishes section handlers ----
  function startEditDishes() {
    setDishDraftRows(dishEntriesToDrafts(savedDishes ?? canonicalDishes));
    setDishEditError(null);
    setEditingDishes(true);
  }
  function saveDishes() {
    const allBlank = dishDraftRows.every((d) => !d.dish.trim() && !d.price.trim());
    if (allBlank) {
      // Clearing every row back to blank means "no dishes correction
      // proposed", not "propose an empty dish list" — is_valid_dishes()
      // requires a non-empty array, so an empty proposal could never be a
      // valid correction anyway.
      setSavedDishes(null);
      setEditingDishes(false);
      setDishEditError(null);
      return;
    }
    const check = validateDishDrafts(dishDraftRows);
    if (!check.ok) return setDishEditError(check.error);
    setSavedDishes(check.entries);
    setEditingDishes(false);
    setDishEditError(null);
  }
  function cancelEditDishes() {
    setEditingDishes(false);
    setDishEditError(null);
  }

  // ---- Location section handlers ----
  function startEditLocation() {
    setPickedCoords(null);
    setPickedLabel(null);
    setEditingLocation(true);
    onPickOnMap?.({ lat: savedCoords?.lat ?? latitude, lon: savedCoords?.lon ?? longitude }, 'manual');
  }
  function saveLocation() {
    if (!pickedCoords) {
      setEditingLocation(false);
      return;
    }
    setSavedCoords(pickedCoords);
    setSavedLocationLabel(pickedLabel);
    setEditingLocation(false);
  }
  function cancelEditLocation() {
    setEditingLocation(false);
    setPickedCoords(null);
  }

  // ---- Photos (community content) ----
  const existingPhotoCount = myReview?.photos.length ?? 0;
  const roomForMorePhotos = Math.max(0, MAX_REVIEW_PHOTOS - existingPhotoCount - photoFiles.length);

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (picked.length === 0) return;
    const accepted = picked.slice(0, roomForMorePhotos);
    setPhotoFiles((prev) => [...prev, ...accepted]);
    setPhotoPreviews((prev) => [...prev, ...accepted.map((f) => URL.createObjectURL(f))]);
  }
  function removeDraftPhoto(index: number) {
    URL.revokeObjectURL(photoPreviews[index]);
    setPhotoFiles((prev) => prev.filter((_, i) => i !== index));
    setPhotoPreviews((prev) => prev.filter((_, i) => i !== index));
  }

  // ---- The one, unified submit ----
  async function submitAll() {
    setSubmitError(null);

    const nameChanged = savedName != null && savedName.trim() !== listingName.trim();
    const dishesChanged = savedDishes != null && JSON.stringify(savedDishes) !== JSON.stringify(canonicalDishes);
    const locationChanged = savedCoords != null && (savedCoords.lat !== latitude || savedCoords.lon !== longitude);

    const reviewValidation = validateReviewDraft(myRating, myReviewText);
    const hasReviewContent = myRating != null || myReviewText.trim().length > 0;
    const hasPhotos = photoFiles.length > 0;

    if (!nameChanged && !dishesChanged && !locationChanged && !hasReviewContent && !hasPhotos) {
      return setSubmitError('Edit a field above, or add a rating/review, before submitting.');
    }
    if (hasPhotos && !hasReviewContent) {
      return setSubmitError('Add a rating or a review to attach photos.');
    }
    const foodCheck = checkFoodRelevance(savedName ?? listingName, myReviewText);
    if (!foodCheck.ok) {
      return setSubmitError(`That doesn't read as food-related — mind rewording the part about "${foodCheck.matchedTerm}"?`);
    }

    setSubmitting(true);
    try {
      const userId = await ensureAnonymousSession();
      if (!userId) {
        setSubmitError('Could not start a session. Please refresh and try again.');
        return;
      }

      if (nameChanged && savedName) {
        const r = await submitNameCorrection(listingId, userId, savedName, null);
        if ('error' in r) return setSubmitError(r.error);
      }
      if (dishesChanged && savedDishes) {
        const r = await submitDishesCorrection(listingId, userId, savedDishes, null);
        if ('error' in r) return setSubmitError(r.error);
      }
      if (locationChanged && savedCoords) {
        const r = await submitLocationCorrection(listingId, userId, savedCoords.lat, savedCoords.lon, savedLocationLabel, null);
        if ('error' in r) return setSubmitError(r.error);
      }

      if (hasReviewContent || hasPhotos) {
        const result = await submitListingReview({
          listingId,
          userId,
          rating: myRating,
          reviewText: reviewValidation.ok ? reviewValidation.reviewText : null,
        });
        if ('error' in result) return setSubmitError(result.error);

        if (photoFiles.length) {
          // Mirrors the same uploadPhotos()/listing_photos insert shape
          // used elsewhere, targeting listing_review_photos instead and a
          // path prefix that keeps review photos distinguishable from a
          // listing's own inside the same shared bucket.
          const uploaded: { url: string; path: string }[] = [];
          for (const file of photoFiles) {
            const ext = file.name.split('.').pop() ?? 'jpg';
            const path = `${userId}/reviews/${result.id}/${Date.now()}-${uploaded.length}.${ext}`;
            const { error: uploadError } = await supabase.storage.from('listing-photos').upload(path, file, {
              contentType: file.type || `image/${ext}`,
            });
            if (uploadError) continue;
            const { data } = supabase.storage.from('listing-photos').getPublicUrl(path);
            uploaded.push({ url: data.publicUrl, path });
          }
          if (uploaded.length) {
            const { error: photosError } = await supabase.from('listing_review_photos').insert(
              uploaded.map((p, i) => ({
                listing_review_id: result.id,
                photo_url: p.url,
                storage_path: p.path,
                position: existingPhotoCount + i,
              }))
            );
            if (photosError) console.warn('Could not save review photos:', photosError.message);
          }
        }
      }

      // Staged corrections are now pending — reset so the read-only
      // sections go back to showing canonical values (the still-pending
      // proposal, not this component's own state, is the record of what
      // was submitted) and Submit Review can't silently re-fire the same
      // correction a second time on an accidental extra click.
      setSavedName(null);
      setSavedDishes(null);
      setSavedCoords(null);
      setSavedLocationLabel(null);
      setPhotoFiles([]);
      setPhotoPreviews([]);

      const correctionsCount = [nameChanged, dishesChanged, locationChanged].filter(Boolean).length;
      const msg =
        hasReviewContent && correctionsCount > 0
          ? 'Thanks! Your review is live, and your changes were sent for admin review.'
          : hasReviewContent
            ? 'Thanks for your review!'
            : 'Thanks! Your changes were sent for admin review.';
      setConfirmation(msg);
      if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
      confirmationTimerRef.current = setTimeout(() => setConfirmation(null), 2600);

      // Back to the read page — that's where the confirmation and the
      // (now live) review actually show up.
      setShowContributePage(false);
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  // The current user's own review is shown in its own read block above,
  // never duplicated into the general list below.
  const otherReviews = reviews.filter((r) => r.id !== myReview?.id);

  const displayCoords = savedCoords ?? { lat: latitude, lon: longitude };
  const displayDishes = savedDishes ?? canonicalDishes;

  return createPortal(
    <div
      className={`review-overlay${hidden ? ' review-overlay-hidden' : ''}`}
      onClick={onClose}
      role="dialog"
      aria-label={`Reviews of ${listingName}`}
    >
      <div className="review-overlay-card" onClick={(e) => e.stopPropagation()}>
        <div className="review-overlay-head">
          <span className="review-overlay-name">{listingName}</span>
          <button className="icon-button" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* The ONE scrollable region — everything below lives inside this,
            nothing in this file renders a second independent scroll
            container or its own fixed-position backdrop. min-height: 0 on
            this flex child is load-bearing (see styles.css) — without it a
            flex item's overflow doesn't actually constrain/scroll, it just
            grows the parent past the card's own max-height instead. */}
        <div className="review-overlay-body">
        {!showContributePage ? (
          <>
          <div className="review-overlay-section">
            <span className="review-overlay-caption">From the listing</span>
            {rating != null ? (
              <span className="review-overlay-rating" aria-label={`Rated ${rating} out of 5`}>
                {'★'.repeat(rating)}
                {'☆'.repeat(5 - rating)}
              </span>
            ) : null}
            <p className="review-overlay-text">{review ? review : `₹${priceRupees}`}</p>
          </div>

          {!loading && myReview ? (
            <div className="review-overlay-section">
              <span className="review-overlay-caption">Your review</span>
              <div className="review-mine">
                {myReview.rating != null ? (
                  <span className="review-item-stars" aria-label={`You rated this ${myReview.rating} out of 5`}>
                    {'★'.repeat(myReview.rating)}
                    {'☆'.repeat(5 - myReview.rating)}
                  </span>
                ) : null}
                {myReview.review_text ? <p className="review-item-text">{myReview.review_text}</p> : null}
                {myReview.photos.length ? (
                  <div className="review-item-photos">
                    {myReview.photos.map((url, i) => (
                      <button
                        key={url}
                        type="button"
                        className="review-item-photo"
                        onClick={() => setLightbox({ photos: myReview.photos, index: i })}
                      >
                        <img src={url} alt="" />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="review-overlay-section">
            <span className="review-overlay-caption">
              {otherReviews.length > 0 ? `Reviews from others (${otherReviews.length})` : 'Reviews from others'}
            </span>
            {loading ? (
              <p className="review-empty-text">Loading…</p>
            ) : otherReviews.length === 0 ? (
              <p className="review-empty-text">No other reviews yet.</p>
            ) : (
              <div className="review-list">
                {otherReviews.map((r) => (
                  <div key={r.id} className="review-item">
                    <div className="review-item-head">
                      {r.rating != null ? (
                        <span className="review-item-stars" aria-label={`Rated ${r.rating} out of 5`}>
                          {'★'.repeat(r.rating)}
                          {'☆'.repeat(5 - r.rating)}
                        </span>
                      ) : null}
                      <span className="review-item-time">{formatRelativeTime(r.created_at)}</span>
                    </div>
                    {r.review_text ? <p className="review-item-text">{r.review_text}</p> : null}
                    {r.photos.length ? (
                      <div className="review-item-photos">
                        {r.photos.map((url, i) => (
                          <button
                            key={url}
                            type="button"
                            className="review-item-photo"
                            onClick={() => setLightbox({ photos: r.photos, index: i })}
                          >
                            <img src={url} alt="" />
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {confirmation ? <p className="review-confirmation">{confirmation}</p> : null}

          {!loading ? (
            <div className="review-overlay-footer">
              <button className="primary-button submit-button" onClick={() => setShowContributePage(true)}>
                {myReview ? 'Edit Review' : 'Add Review'}
              </button>
            </div>
          ) : null}
          </>
        ) : (
          <>
          <button className="text-button-inline review-back-link" onClick={() => setShowContributePage(false)}>
            ← Back
          </button>

          {/* ---- Restaurant name (canonical correction) ---- */}
          <div className="review-overlay-section">
            <span className="review-overlay-caption">Restaurant name</span>
            {editingName ? (
              <div className="correction-form">
                <input className="text-input" value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
                {nameEditError ? <div className="error-text">{nameEditError}</div> : null}
                <div className="review-field-actions">
                  <button className="secondary-button" onClick={cancelEditName}>Cancel</button>
                  <button className="primary-button" onClick={saveName}>Save</button>
                </div>
              </div>
            ) : (
              <div className="review-field-readonly">
                <span className="review-field-value">{savedName ?? listingName}</span>
                <button className="text-button-inline" onClick={startEditName}>Edit name</button>
              </div>
            )}
          </div>

          {/* ---- Dishes & prices (canonical correction) ---- */}
          <div className="review-overlay-section">
            <span className="review-overlay-caption">Dishes &amp; prices</span>
            {editingDishes ? (
              <div className="correction-form">
                <DishPriceRows drafts={dishDraftRows} onChange={setDishDraftRows} error={dishEditError} requireFirst={false} />
                <div className="review-field-actions">
                  <button className="secondary-button" onClick={cancelEditDishes}>Cancel</button>
                  <button className="primary-button" onClick={saveDishes}>Save</button>
                </div>
              </div>
            ) : (
              <div className="review-field-readonly">
                <div className="review-dish-list">
                  {displayDishes.length === 0 ? (
                    <span className="review-empty-text">No dishes listed yet.</span>
                  ) : (
                    displayDishes.map((d, i) => (
                      <div key={`${d.dish}-${i}`} className="review-dish-row">
                        {d.dish} · ₹{d.price}
                      </div>
                    ))
                  )}
                </div>
                <button className="text-button-inline" onClick={startEditDishes}>Edit dishes</button>
              </div>
            )}
          </div>

          {/* ---- Location (canonical correction) ---- */}
          <div className="review-overlay-section">
            <span className="review-overlay-caption">Location</span>
            {editingLocation ? (
              <div className="correction-form">
                {pickedCoords ? (
                  <div className="pinned-banner">
                    <div className="pinned-banner-text">
                      Pinned ✓ ({pickedCoords.lat.toFixed(4)}, {pickedCoords.lon.toFixed(4)})
                      {resolvingPickedLabel ? (
                        <span className="pinned-location pinned-location-resolving">Finding the address…</span>
                      ) : pickedLabel ? (
                        <span className="pinned-location">{pickedLabel}</span>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <p className="review-empty-text">Tap the map to choose a location.</p>
                )}
                <button
                  type="button"
                  className="tab-button"
                  onClick={() => onPickOnMap?.({ lat: pickedCoords?.lat ?? displayCoords.lat, lon: pickedCoords?.lon ?? displayCoords.lon }, 'manual')}
                >
                  {pickedCoords ? 'Adjust again' : 'Pick on map'}
                </button>
                <div className="review-field-actions">
                  <button className="secondary-button" onClick={cancelEditLocation}>Cancel</button>
                  <button className="primary-button" onClick={saveLocation} disabled={!pickedCoords}>Save</button>
                </div>
              </div>
            ) : (
              <div className="review-field-readonly">
                <span className="review-field-value">
                  {displayCoords.lat.toFixed(4)}, {displayCoords.lon.toFixed(4)}
                  {savedLocationLabel ? ` (${savedLocationLabel})` : ''}
                </span>
                {onPickOnMap ? (
                  <button className="text-button-inline" onClick={startEditLocation}>Edit location</button>
                ) : null}
              </div>
            )}
          </div>

          {/* ---- Rating / review / photos — community content, always open ---- */}
          <div className="review-overlay-section">
            <span className="review-overlay-caption">Your rating (optional)</span>
            <div className="rating-input" role="group" aria-label="Your rating out of 5">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  type="button"
                  key={star}
                  onClick={() => setMyRating((current) => (current === star ? null : star))}
                  className={`rating-star${myRating != null && star <= myRating ? ' rating-star-on' : ''}`}
                  aria-label={`${star} star${star > 1 ? 's' : ''}`}
                  aria-pressed={myRating != null && star <= myRating}
                >
                  ★
                </button>
              ))}
            </div>
          </div>

          <div className="review-overlay-section">
            <span className="review-overlay-caption">Your review (optional)</span>
            <textarea
              className="text-input textarea"
              value={myReviewText}
              onChange={(e) => setMyReviewText(e.target.value.slice(0, REVIEW_TEXT_MAX_LENGTH))}
              maxLength={REVIEW_TEXT_MAX_LENGTH}
              placeholder="How was the food, the service, the value?"
            />
            <span className="field-hint">
              {myReviewText.length}/{REVIEW_TEXT_MAX_LENGTH}
            </span>
          </div>

          <div className="review-overlay-section">
            <span className="review-overlay-caption">Photos (optional, up to {MAX_REVIEW_PHOTOS})</span>
            <div className="photo-thumbs">
              {myReview?.photos.map((url) => (
                <div key={url} className="photo-thumb">
                  <img src={url} alt="" />
                </div>
              ))}
              {photoPreviews.map((src, i) => (
                <div key={src} className="photo-thumb">
                  <img src={src} alt="" />
                  <button type="button" className="photo-thumb-remove" onClick={() => removeDraftPhoto(i)} aria-label="Remove photo">
                    ✕
                  </button>
                </div>
              ))}
              {roomForMorePhotos > 0 ? (
                <button type="button" className="text-button-inline photo-add-link" onClick={() => fileInputRef.current?.click()}>
                  + Add photo{existingPhotoCount > 0 || photoFiles.length > 0 ? '' : 's'}
                </button>
              ) : null}
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handlePhotoChange} style={{ display: 'none' }} />
          </div>

          {submitError ? <div className="error-text">{submitError}</div> : null}

          <p className="field-hint review-mode-notice">
            Your rating, review and photos publish immediately. Changes to the name, dishes, or location are reviewed by an admin
            before they update the listing.
          </p>

          <div className="review-overlay-footer">
            <button className="primary-button submit-button" onClick={submitAll} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit Review'}
            </button>
          </div>
          </>
        )}
        </div>
      </div>

      {lightbox ? (
        <PhotoLightbox photos={lightbox.photos} startIndex={lightbox.index} listingName={listingName} onClose={() => setLightbox(null)} />
      ) : null}
    </div>,
    document.body
  );
}
