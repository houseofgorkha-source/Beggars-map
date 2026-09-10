import { useEffect, useRef, useState } from 'react';
import { supabase, ensureAnonymousSession } from '../lib/supabase';
import { createListing } from '../lib/listings';
import { extractLatLngFromText } from '../lib/extractGoogleCoords';
import { checkFoodRelevance } from '../lib/contentModeration';
import { reverseGeocode } from '../lib/reverseGeocode';
import { validateDishDrafts, type DishDraft } from '../lib/dishes';
import DishPriceRows from './DishPriceRows';

// Location provenance (Stage 2A, 0015) — how the coordinate this modal is
// about to submit was actually obtained. Tracked alongside `coords` itself
// (every setCoords-equivalent call site below sets this too) rather than
// derived after the fact, since by submit time there's no way to reconstruct
// which of several possible paths produced the final value.
type LocationSource = 'user_pin' | 'device_gps' | 'ola' | 'google' | 'unknown';

type Props = {
  onClose: () => void;
  onPosted: () => void;
  // Only ever seeded by App.tsx from an OLA-resolved search result (see
  // addSearchedPlace/confirmAddThisPlace in App.tsx) — never from a blank
  // "+ Add" with no prior search, which passes undefined instead. This is
  // what makes 'ola' the correct default location_source below whenever this
  // is present at mount.
  initialCoords?: { lat: number; lon: number };
  // "Pick on map" hands off to the real full-screen map instead of an
  // embedded mini-map — this reports the modal's current location (if any)
  // so that map can seed a candidate pin there, then the modal hides itself
  // (see `hidden` below) until the caller reports a result via
  // `pickedLocation`. `source` just tells the caller which explanatory
  // copy to show ("tap the map" vs. "confirm your GPS fix").
  onPickOnMap: (current: { lat: number; lon: number } | null, source?: 'manual' | 'current-location') => void;
  // `placeId` is present only when the pick was a tap on one of Google's own
  // base-map POI icons rather than a plain pin drop (see App.tsx's
  // confirmAddThisPlace/MapView's poiSelectable) — real Google place
  // identity, not a guess, so it's worth recording as provenance.
  pickedLocation?: { lat: number; lon: number; token: number; source: 'manual' | 'current-location'; placeId?: string } | null;
  hidden?: boolean;
};

type LocationMode = 'current' | 'link';

// Short by design — this shows as a pop-up on the map pin, not a paragraph.
const NOTE_MAX_LENGTH = 70;
const MAX_PHOTOS = 4;

export default function AddListingModal({ onClose, onPosted, initialCoords, onPickOnMap, pickedLocation, hidden }: Props) {
  const [name, setName] = useState('');
  // One Dish + Price pair minimum; "+ Add more" appends another. The
  // cheapest entry becomes the listing's price_rupees at submit time (see
  // lib/dishes.ts) — that column stays the sort key and the ₹100-cap column.
  const [dishDrafts, setDishDrafts] = useState<DishDraft[]>([{ dish: '', price: '' }]);
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(initialCoords ?? null);
  // See the Props comment on initialCoords for why 'ola' is the correct
  // starting value whenever a coordinate is already present at mount.
  const [locationSource, setLocationSource] = useState<LocationSource>(initialCoords ? 'ola' : 'unknown');
  // A real Google place_id, captured only via a POI tap while picking on the
  // map (see the Props comment on pickedLocation) — never set any other way,
  // never guessed. Reset alongside every other location-setting path so a
  // placeId from an earlier pick can never leak into a later, different one.
  const [locationPlaceId, setLocationPlaceId] = useState<string | undefined>(undefined);
  const [locationMode, setLocationMode] = useState<LocationMode>('current');
  const [locating, setLocating] = useState(false);
  // Whether the "how do I get coordinates" popover is open — same pattern
  // as ListingDetailModal's report popover (a wrap ref + outside-click
  // effect below), not a new interaction model.
  const [showCoordsHelp, setShowCoordsHelp] = useState(false);
  // Whether the popover has room to open downward from the trigger, or
  // needs to flip upward instead — this modal's body scrolls and the
  // trigger sits fairly far down the form, so a fixed "always opens below"
  // popover could run past the visible viewport (observed: it covered the
  // Post listing button). Measured against the real viewport each time the
  // popover opens, not assumed from the modal's own layout.
  const [coordsHelpPlacement, setCoordsHelpPlacement] = useState<'top' | 'bottom'>('bottom');
  const coordsHelpWrapRef = useRef<HTMLDivElement>(null);
  // Generous estimate of the popover's own rendered height (three short
  // lines + padding) — enough to decide the flip without a two-pass
  // render-then-measure dance for a fixed, small piece of content.
  const COORDS_HELP_POPOVER_HEIGHT = 190;
  // Resolved from `coords` via reverse geocoding — a human-readable
  // descriptor ("100 Feet Road, Indiranagar") shown to the user for
  // confidence and submitted alongside the exact lat/lon, which stays the
  // authoritative location regardless of whether this resolves to anything.
  // Re-resolved (see the effect below) every time coords changes, since
  // each location source (GPS, map pick, pasted link) can update coords
  // independently at any point before submission.
  const [locationLabel, setLocationLabel] = useState<string | null>(null);
  const [resolvingLocation, setResolvingLocation] = useState(false);
  // The reverse-geocode call currently in flight (if any) — submit() awaits
  // this (bounded by a short timeout) rather than reading `locationLabel`
  // state directly, so a submit that happens to land in the gap between
  // picking a location and the lookup resolving still gets the address
  // instead of silently shipping null. Real listings were observed with
  // location_label stuck null despite reverse geocoding succeeding for
  // their exact coordinates when tested directly — this race is why.
  const locationPromiseRef = useRef<Promise<string | null> | null>(null);

  const [mapsLink, setMapsLink] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept separate from `error` so this renders persistently right under the
  // Dish + Price fields (where the mistake actually is) rather than at the
  // bottom of the form with everything else — a price/single-item mistake
  // is the one error a user is likeliest to make while still looking at
  // these fields, not after scrolling past them.
  const [dishError, setDishError] = useState<string | null>(null);

  // Pushed in from App.tsx after the user places a pin on the real
  // full-screen map (see onPickOnMap below) — coords/locationMode are local
  // state here, only seeded from `initialCoords` at mount, so a later prop
  // update needs an explicit effect to reach an already-mounted instance.
  // Keyed on the token (not the lat/lon values) so picking the same spot
  // twice in a row still counts as a fresh confirmation — same idiom as
  // flyToCenter elsewhere in this app.
  useEffect(() => {
    if (!pickedLocation) return;
    setCoords({ lat: pickedLocation.lat, lon: pickedLocation.lon });
    // Both branches are an explicit human confirmation of this exact point on
    // the map — 'current-location' still means the user looked at their GPS
    // fix on the map and kept it, not that GPS was trusted blind. The
    // distinction that matters for location_source is device_gps (raw,
    // unconfirmed — this app never actually does that) vs user_pin (a human
    // looked at the map and confirmed/placed the point), and this is always
    // the latter — UNLESS the pick was a tap on one of Google's own POI
    // icons, which is real provider identity (not a guess) and worth
    // recording as 'google' rather than the generic 'user_pin'.
    setLocationSource(pickedLocation.placeId ? 'google' : 'user_pin');
    setLocationPlaceId(pickedLocation.placeId);
    setLocationMode('current');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedLocation?.token]);

  // Resolves a human-readable descriptor for whatever coords are currently
  // set, from any of the three location sources. Clears any previous
  // label immediately (not just on the async response) — submitting while
  // a fresh lookup is still in flight must send null rather than the prior
  // location's now-stale descriptor; null is always safe here (it just
  // means no descriptor yet), a mismatched one would not be. `cancelled`
  // additionally drops a resolved result if coords changed again before it
  // arrived, for the same reason.
  useEffect(() => {
    setLocationLabel(null);
    locationPromiseRef.current = null;
    if (!coords) return;
    let cancelled = false;
    setResolvingLocation(true);
    const promise = reverseGeocode(coords.lat, coords.lon);
    locationPromiseRef.current = promise;
    promise.then((label) => {
      if (cancelled) return;
      setLocationLabel(label);
      setResolvingLocation(false);
    });
    return () => {
      cancelled = true;
    };
  }, [coords]);

  // Closes the coordinates-help popover on an outside tap — identical
  // pattern to ListingDetailModal's report popover.
  useEffect(() => {
    if (!showCoordsHelp) return;
    function handlePointerDown(e: MouseEvent) {
      if (coordsHelpWrapRef.current?.contains(e.target as Node)) return;
      setShowCoordsHelp(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showCoordsHelp]);

  // Measures real available viewport space against the coordinate-help
  // trigger's own wrap so it can decide top-vs-bottom fresh on every open,
  // since the modal's scroll position can change between opens.
  function measurePopoverPlacement(el: HTMLElement | null, estimatedHeight: number): 'top' | 'bottom' {
    if (!el) return 'bottom';
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    return spaceBelow < estimatedHeight && spaceAbove > spaceBelow ? 'top' : 'bottom';
  }

  // Hands the GPS fix off to the same full-screen map confirmation "Pick on
  // map" uses, instead of applying it straight to `coords` — GPS can be off
  // (indoors, weak signal), so the user gets to see the point on the map
  // and explicitly confirm ("Use this spot") or adjust it first.
  function useCurrentLocation() {
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        onPickOnMap({ lat: pos.coords.latitude, lon: pos.coords.longitude }, 'current-location');
      },
      (err) => {
        // A prior denial for this site means the browser never shows the
        // permission prompt again — it fails immediately with code 1
        // (PERMISSION_DENIED). That reads as "nothing happened" unless the
        // message says so explicitly, since there's no popup to explain it.
        const message =
          err.code === err.PERMISSION_DENIED
            ? 'Location access is blocked for this site — check your browser or phone’s site settings, or use another option below.'
            : err.code === err.TIMEOUT
              ? 'Location took too long to respond. Try another option below.'
              : 'Could not get your location. Try another option below.';
        setError(message);
        setLocating(false);
      },
      { timeout: 10000 }
    );
  }

  // Deliberately coordinates-only — no URL resolution, no short-link
  // follow, no Places API, no OLA fallback, no guessing of any kind. The
  // user gets the exact coordinate straight from Google Maps' own
  // "What's here?" (desktop right-click) / long-press-and-copy (mobile)
  // feature and pastes it verbatim; extractLatLngFromText is a synchronous,
  // whole-string, range-validated match, so this never touches the network.
  function usePastedCoordinates() {
    if (!mapsLink.trim()) return;
    setError(null);
    const parsed = extractLatLngFromText(mapsLink);
    if (!parsed) {
      setError('Could not read those coordinates — paste them exactly as Google Maps shows them, e.g. 12.9723, 77.7345.');
      return;
    }
    setCoords({ lat: parsed.latitude, lon: parsed.longitude });
    setLocationSource(parsed.source);
    setLocationPlaceId(undefined);
    setMapsLink('');
  }

  // Lets the user back out of a pin they no longer want, from any of the
  // three location sources — the effect above already resets
  // locationLabel/resolvingLocation to their empty state whenever coords
  // goes null, so there's nothing else to clean up here.
  function clearLocation() {
    setCoords(null);
    setLocationSource('unknown');
    setLocationPlaceId(undefined);
    setError(null);
  }

  // Shared by the file-picker's onChange and the clipboard-paste handler
  // below — one place that respects MAX_PHOTOS and builds previews,
  // regardless of how a File/Blob actually arrived.
  function addPhotoFiles(files: File[]) {
    if (files.length === 0) return;
    const room = MAX_PHOTOS - photoFiles.length;
    if (room <= 0) return;
    const accepted = files.slice(0, room);
    setPhotoFiles((prev) => [...prev, ...accepted]);
    setPhotoPreviews((prev) => [...prev, ...accepted.map((f) => URL.createObjectURL(f))]);
  }

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow picking the same file again later
    addPhotoFiles(picked);
  }

  // Ordinary copy/paste for photos — same underlying idea as the Discovery
  // Workbench's own photo paste box (CandidateDetail.tsx's handlePaste):
  // check clipboardData.items for an image, hand the File to the normal
  // add-photo path.
  //
  // The box itself is `contentEditable`, not just a focusable plain <div> —
  // that's load-bearing, not decorative. A plain div (even with tabIndex)
  // can still receive a paste fired by the Ctrl+V keyboard shortcut, but
  // browsers only offer "Paste" in the right-click context menu (desktop)
  // or the long-press selection menu (mobile) over an element they
  // recognize as an actual text-editing surface — a real input/textarea,
  // or contentEditable. Without this, there was no right-click/long-press
  // path at all, only the keyboard shortcut. preventDefault stops the
  // browser's own contentEditable behavior (inserting the image as a real
  // <img> node, or raw text, into the box itself) — this box's own content
  // must always stay empty; the placeholder text is a pure CSS
  // `:empty::before`, never real DOM content.
  function handlePhotoPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    e.preventDefault();
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) addPhotoFiles([file]);
    e.currentTarget.textContent = '';
  }

  // Blocks ordinary typing into the paste box — it's contentEditable only
  // so the browser offers a native Paste option (see handlePhotoPaste
  // above), never so a stray click-and-type could leave real text sitting
  // in it. Ctrl+V/Cmd+V itself must still go through untouched.
  function handlePhotoBoxKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!(e.ctrlKey || e.metaKey) && e.key !== 'Tab') e.preventDefault();
  }

  function removePhoto(index: number) {
    URL.revokeObjectURL(photoPreviews[index]);
    setPhotoFiles((prev) => prev.filter((_, i) => i !== index));
    setPhotoPreviews((prev) => prev.filter((_, i) => i !== index));
  }

  async function uploadPhotos(userId: string): Promise<{ url: string; path: string }[]> {
    const uploaded: { url: string; path: string }[] = [];
    for (const [i, file] of photoFiles.entries()) {
      const ext = file.name.split('.').pop() ?? 'jpg';
      const path = `${userId}/${Date.now()}-${i}.${ext}`;
      const { error: uploadError } = await supabase.storage.from('listing-photos').upload(path, file, {
        contentType: file.type || `image/${ext}`,
      });
      // Best-effort, matching the original single-photo behavior: a failed
      // upload just doesn't make it into the listing rather than blocking
      // the whole submission.
      if (uploadError) continue;
      const { data } = supabase.storage.from('listing-photos').getPublicUrl(path);
      uploaded.push({ url: data.publicUrl, path });
    }
    return uploaded;
  }

  // Waits for a reverse-geocode already in flight, capped at 4s so a slow
  // (or hung — reverseGeocode has no fetch timeout of its own) request can
  // never block submission indefinitely. A promise that already resolved
  // (the common case — geocoding is usually much faster than the user
  // finishes filling in the rest of the form) settles this immediately.
  // Never fabricates: no in-flight lookup, or the timeout wins, both yield
  // null, exactly like today's "geocoding found nothing" case.
  function resolveLocationLabel(): Promise<string | null> {
    const promise = locationPromiseRef.current;
    if (!promise) return Promise.resolve(null);
    return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))]);
  }

  async function submit() {
    setError(null);
    setDishError(null);

    if (!name.trim()) return setError('Give this spot a name.');
    // Validates every pair — price range (₹30-₹100), that each dish reads
    // as a qualifying complete meal (not a single item), and derives
    // price_rupees from the cheapest entry — all in shared, unit-tested
    // logic so web and mobile can't disagree about what's valid.
    const dishCheck = validateDishDrafts(dishDrafts);
    if (!dishCheck.ok) return setDishError(dishCheck.error);
    if (!coords) return setError('Set a location using one of the options below.');
    const foodCheck = checkFoodRelevance(name, note);
    if (!foodCheck.ok) {
      return setError(`Beggars Map is for affordable eats only — this looks like it might be about "${foodCheck.matchedTerm}" instead.`);
    }

    setSubmitting(true);
    try {
      const userId = await ensureAnonymousSession();
      if (!userId) {
        setError('Could not start a session. Please refresh and try again.');
        return;
      }

      const [photos, resolvedLabel] = await Promise.all([uploadPhotos(userId), resolveLocationLabel()]);

      const insertResult = await createListing({
        created_by: userId,
        name: name.trim(),
        // Derived, not typed in: the cheapest dish. Keeps price_rupees
        // consistent with `dishes` by construction.
        price_rupees: dishCheck.priceRupees,
        dishes: dishCheck.entries,
        rating,
        note: note.trim() || null,
        // First photo doubles as the single `photo_url` every other
        // consumer (list card, map popup, listing detail, mobile app)
        // already knows how to show — the rest live only in
        // `listing_photos`, additive, nothing else needs to change.
        photo_url: photos[0]?.url ?? null,
        latitude: coords.lat,
        longitude: coords.lon,
        // Best-effort human-readable descriptor for the same coords —
        // null when reverse geocoding hasn't resolved (or found) anything
        // within resolveLocationLabel's own wait window, never a
        // placeholder/fabricated value.
        location_label: resolvedLabel,
        // Stage 2A location provenance (0015) — set at every point above
        // that changes `coords`, never inferred here at submit time.
        location_source: locationSource,
        // Real Google place identity captured by a POI tap — omitted
        // entirely (not even `{}`) unless one was actually captured, so a
        // plain pin-drop or paste-link submission never fabricates one.
        // NOTE: as of this writing, 0015's INSERT-time trigger still forces
        // this back to `{}` regardless of what's sent — a known, planned
        // sequencing gap closed by a separate migration, not a bug here.
        ...(locationPlaceId ? { provider_place_ids: { google: locationPlaceId } } : {}),
      });

      if ('error' in insertResult) {
        // The listing never got created, so these uploads are orphaned —
        // clean them up rather than leaving them in storage forever.
        // Best-effort: if this delete also fails, the original insert error
        // is still what gets shown to the user.
        if (photos.length) await supabase.storage.from('listing-photos').remove(photos.map((p) => p.path));
        setError(insertResult.error);
        return;
      }
      const inserted = { id: insertResult.id };

      if (photos.length > 1) {
        const { error: photosError } = await supabase
          .from('listing_photos')
          .insert(photos.map((p, i) => ({ listing_id: inserted.id, photo_url: p.url, storage_path: p.path, position: i })));
        // Non-fatal: the listing itself (with its first photo) was already
        // created successfully — the extra photos are an enhancement, not
        // required for the listing to exist.
        if (photosError) console.warn('Could not save extra photos:', photosError.message);
      }

      onPosted();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // Faded out (not unmounted) while the user is picking a location on the
    // full-screen map behind this modal, so this component's own draft
    // state survives the round-trip untouched. A fade (via the
    // .modal-backdrop-hidden class, not an instant `display: none`) so the
    // handoff reads as a deliberate transition rather than the page
    // glitching — an instant cut was confusing enough to look like a bug.
    // There's deliberately no way to close the modal via its own ✕ while
    // hidden — Cancel/Confirm on the map are the only ways back (see
    // startPickingLocation/onPickOnMap in App.tsx).
    <div className={`modal-backdrop${hidden ? ' modal-backdrop-hidden' : ''}`} onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add a listing</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body">
          <label className="field-label">Name</label>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Amma's Idli Corner" />

          <DishPriceRows drafts={dishDrafts} onChange={setDishDrafts} error={dishError} />

          <label className="field-label">Rating (optional)</label>
          <div className="rating-input" role="group" aria-label="Rating out of 5">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                type="button"
                key={star}
                // Tapping the currently-selected star clears the rating, so
                // an accidental tap isn't permanent on a form with no other
                // way to unset it.
                onClick={() => setRating((current) => (current === star ? null : star))}
                className={`rating-star${rating != null && star <= rating ? ' rating-star-on' : ''}`}
                aria-label={`${star} star${star > 1 ? 's' : ''}`}
                aria-pressed={rating != null && star <= rating}
              >
                ★
              </button>
            ))}
          </div>

          <label className="field-label">Review (optional)</label>
          <textarea
            className="text-input textarea"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX_LENGTH))}
            maxLength={NOTE_MAX_LENGTH}
            placeholder="e.g. Great thali, open till 6pm"
          />
          <span className="field-hint">Keep it short — shows as a pop-up on the map ({note.length}/{NOTE_MAX_LENGTH})</span>

          <label className="field-label">Photos (optional, up to {MAX_PHOTOS})</label>
          <div className="photo-thumbs">
            {photoPreviews.map((src, i) => (
              <div key={src} className="photo-thumb">
                <img src={src} alt="" />
                <button type="button" className="photo-thumb-remove" onClick={() => removePhoto(i)} aria-label="Remove photo">
                  ✕
                </button>
              </div>
            ))}
            {photoFiles.length < MAX_PHOTOS ? (
              // contentEditable (not just a focusable plain div) is what
              // makes the browser offer a real "Paste" item on right-click
              // (desktop) or in the long-press selection menu (mobile) —
              // see handlePhotoPaste's own comment for why. Sits directly
              // beside the existing thumbnails so an already-added photo
              // and this empty frame read as one row of "slots", with
              // "+ Add photos" moved to its own line below.
              <div
                className="photo-paste-box"
                contentEditable
                suppressContentEditableWarning
                tabIndex={0}
                role="textbox"
                aria-label="Paste a photo"
                onPaste={handlePhotoPaste}
                onKeyDown={handlePhotoBoxKeyDown}
                title="Right-click or long-press here, then Paste"
              />
            ) : null}
          </div>
          {photoFiles.length < MAX_PHOTOS ? (
            <button type="button" className="text-button-inline photo-add-link" onClick={() => fileInputRef.current?.click()}>
              + Add photo{photoFiles.length > 0 ? '' : 's'}
            </button>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handlePhotoChange}
            style={{ display: 'none' }}
          />

          <label className="field-label">Location</label>
          {coords ? (
            <div className="pinned-banner">
              <div className="pinned-banner-text">
                Pinned ✓ ({coords.lat.toFixed(4)}, {coords.lon.toFixed(4)})
                {resolvingLocation ? (
                  <span className="pinned-location pinned-location-resolving">Finding the address…</span>
                ) : locationLabel ? (
                  <span className="pinned-location">{locationLabel}</span>
                ) : null}
              </div>
              <button type="button" className="pinned-clear-button" onClick={clearLocation} aria-label="Clear pinned location">✕</button>
            </div>
          ) : null}

          <div className="location-tabs">
            {/* No `active` state here — `locationMode` defaults to 'current'
                and is also reset to it after "Pick on map" resolves (see the
                pickedLocation effect above), so this button used to render
                as permanently "selected" (solid pink fill) from the moment
                the modal opened, even before any location existed, and
                stayed that way after using Pick on Map instead. The Pinned
                banner above already shows whether/how a location is set —
                these three don't need a second, misleading indicator. */}
            <button className="tab-button" onClick={useCurrentLocation} disabled={locating}>
              {locating ? 'Locating…' : 'Use current location'}
            </button>
            <button className="tab-button" onClick={() => onPickOnMap(coords, 'manual')}>Pick on map</button>
            {/* This is the one tab that legitimately toggles visible
                content (the paste-coordinates input row right below), so it
                keeps an `active` state — just a subtle one, not a solid
                fill, since "this section is expanded" isn't the same thing
                as "this is the confirmed location source". */}
            <div className="location-tab-with-info" ref={coordsHelpWrapRef}>
              <button className={`tab-button ${locationMode === 'link' ? 'active' : ''}`} onClick={() => setLocationMode('link')}>Paste coordinates from Google Maps</button>
              <button
                type="button"
                className="location-info-button"
                onClick={() => {
                  if (!showCoordsHelp) {
                    setCoordsHelpPlacement(measurePopoverPlacement(coordsHelpWrapRef.current, COORDS_HELP_POPOVER_HEIGHT));
                  }
                  setShowCoordsHelp((v) => !v);
                }}
                aria-label="How to get coordinates from Google Maps"
                title="How to get coordinates from Google Maps"
              >
                ⓘ
              </button>
              {showCoordsHelp ? (
                <div className={`location-info-popover ${coordsHelpPlacement === 'top' ? 'location-info-popover-top' : ''}`}>
                  <p className="location-info-line">
                    <strong>Desktop:</strong> right-click the exact spot on Google Maps, then click the
                    coordinates shown in the menu to copy them.
                  </p>
                  <p className="location-info-line">
                    <strong>Mobile:</strong> long-press the exact spot — the coordinates appear at the top
                    or bottom of the screen depending on your device. Copy them, then come back here and
                    paste them below (they won't fill in automatically).
                  </p>
                  <p className="location-info-example">Example: 12.9723, 77.7345</p>
                </div>
              ) : null}
            </div>
          </div>

          {/* "Can't find the restaurant?" fallback guidance now lives on the
              full-screen map/search flow itself (App.tsx's picking-dialog,
              shown right after "Pick on map" is clicked) — not here, since
              this modal is hidden for the entire duration of that flow and
              a note living behind a hidden screen couldn't help anyone
              actually searching. See App.tsx for the current copy. */}

          {locationMode === 'link' ? (
            <div className="link-row">
              <input className="text-input" value={mapsLink} onChange={(e) => setMapsLink(e.target.value)} placeholder="e.g. 12.9723, 77.7345" />
              <button className="secondary-button" onClick={usePastedCoordinates}>Use</button>
            </div>
          ) : null}

          {error ? <div className="error-text">{error}</div> : null}

          <button className="primary-button submit-button" onClick={submit} disabled={submitting}>
            {submitting ? 'Posting…' : 'Post listing'}
          </button>
        </div>
      </div>
    </div>
  );
}
