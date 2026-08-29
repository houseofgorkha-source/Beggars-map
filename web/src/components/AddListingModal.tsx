import { useEffect, useRef, useState } from 'react';
import { supabase, ensureAnonymousSession } from '../lib/supabase';
import { parseGoogleMapsUrl } from '../lib/googleMapsLink';
import { checkFoodRelevance } from '../lib/contentModeration';
import { reverseGeocode } from '../lib/reverseGeocode';

type Props = {
  onClose: () => void;
  onPosted: () => void;
  initialCoords?: { lat: number; lon: number };
  // "Pick on map" hands off to the real full-screen map instead of an
  // embedded mini-map — this reports the modal's current location (if any)
  // so that map can seed a candidate pin there, then the modal hides itself
  // (see `hidden` below) until the caller reports a result via
  // `pickedLocation`. `source` just tells the caller which explanatory
  // copy to show ("tap the map" vs. "confirm your GPS fix").
  onPickOnMap: (current: { lat: number; lon: number } | null, source?: 'manual' | 'current-location') => void;
  pickedLocation?: { lat: number; lon: number; token: number } | null;
  hidden?: boolean;
};

type LocationMode = 'current' | 'link';

// Short by design — this shows as a pop-up on the map pin, not a paragraph.
const NOTE_MAX_LENGTH = 70;
const MAX_PHOTOS = 4;

export default function AddListingModal({ onClose, onPosted, initialCoords, onPickOnMap, pickedLocation, hidden }: Props) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(initialCoords ?? null);
  const [locationMode, setLocationMode] = useState<LocationMode>('current');
  const [locating, setLocating] = useState(false);
  // Resolved from `coords` via reverse geocoding — a human-readable
  // descriptor ("100 Feet Road, Indiranagar") shown to the user for
  // confidence and submitted alongside the exact lat/lon, which stays the
  // authoritative location regardless of whether this resolves to anything.
  // Re-resolved (see the effect below) every time coords changes, since
  // each location source (GPS, map pick, pasted link) can update coords
  // independently at any point before submission.
  const [locationLabel, setLocationLabel] = useState<string | null>(null);
  const [resolvingLocation, setResolvingLocation] = useState(false);

  const [mapsLink, setMapsLink] = useState('');
  const [parsingLink, setParsingLink] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (!coords) return;
    let cancelled = false;
    setResolvingLocation(true);
    reverseGeocode(coords.lat, coords.lon).then((label) => {
      if (cancelled) return;
      setLocationLabel(label);
      setResolvingLocation(false);
    });
    return () => {
      cancelled = true;
    };
  }, [coords]);

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
      () => {
        setError('Could not get your location. Try another option below.');
        setLocating(false);
      }
    );
  }

  async function useMapsLink() {
    if (!mapsLink.trim()) return;
    setParsingLink(true);
    setError(null);
    const parsed = await parseGoogleMapsUrl(mapsLink);
    setParsingLink(false);
    if (!parsed) {
      setError('Could not read that link — try pasting the full Google Maps link, or use another option.');
      return;
    }
    setCoords({ lat: parsed.latitude, lon: parsed.longitude });
    setMapsLink('');
  }

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow picking the same file again later
    if (picked.length === 0) return;

    const room = MAX_PHOTOS - photoFiles.length;
    const accepted = picked.slice(0, room);
    setPhotoFiles((prev) => [...prev, ...accepted]);
    setPhotoPreviews((prev) => [...prev, ...accepted.map((f) => URL.createObjectURL(f))]);
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

  async function submit() {
    setError(null);
    const priceNumber = Number(price);

    if (!name.trim()) return setError('Give this spot a name.');
    if (!priceNumber || priceNumber <= 0 || priceNumber > 100) return setError('Price must be ₹100 or under.');
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

      const photos = await uploadPhotos(userId);

      const { data: inserted, error: insertError } = await supabase
        .from('listings')
        .insert({
          created_by: userId,
          name: name.trim(),
          price_rupees: priceNumber,
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
          // by submission time, never a placeholder/fabricated value.
          location_label: locationLabel,
        })
        .select('id')
        .single();

      if (insertError || !inserted) {
        // The listing never got created, so these uploads are orphaned —
        // clean them up rather than leaving them in storage forever.
        // Best-effort: if this delete also fails, the original insert error
        // is still what gets shown to the user.
        if (photos.length) await supabase.storage.from('listing-photos').remove(photos.map((p) => p.path));
        setError(insertError?.message ?? 'Could not create listing.');
        return;
      }

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

          <label className="field-label">Price (₹ per plate/meal, max ₹100)</label>
          <input
            className="text-input"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="30"
            type="number"
            min={1}
            max={100}
          />

          <label className="field-label">Note (optional)</label>
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
              <button type="button" className="text-button-inline photo-add-link" onClick={() => fileInputRef.current?.click()}>
                + Add photo{photoFiles.length > 0 ? '' : 's'}
              </button>
            ) : null}
          </div>
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
              Pinned ✓ ({coords.lat.toFixed(4)}, {coords.lon.toFixed(4)})
              {resolvingLocation ? (
                <span className="pinned-location pinned-location-resolving">Finding the address…</span>
              ) : locationLabel ? (
                <span className="pinned-location">{locationLabel}</span>
              ) : null}
            </div>
          ) : null}

          <div className="location-tabs">
            <button className={`tab-button ${locationMode === 'current' ? 'active' : ''}`} onClick={useCurrentLocation} disabled={locating}>
              {locating ? 'Locating…' : 'Use current location'}
            </button>
            <button className="tab-button" onClick={() => onPickOnMap(coords, 'manual')}>Pick on map</button>
            <button className={`tab-button ${locationMode === 'link' ? 'active' : ''}`} onClick={() => setLocationMode('link')}>Paste link</button>
          </div>

          {locationMode === 'link' ? (
            <div className="link-row">
              <input className="text-input" value={mapsLink} onChange={(e) => setMapsLink(e.target.value)} placeholder="https://maps.app.goo.gl/..." />
              <button className="secondary-button" onClick={useMapsLink} disabled={parsingLink}>{parsingLink ? '…' : 'Use'}</button>
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
