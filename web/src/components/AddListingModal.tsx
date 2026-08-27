import { useEffect, useRef, useState } from 'react';
import { supabase, ensureAnonymousSession } from '../lib/supabase';
import { searchPlaces, type PlaceSuggestion } from '../lib/olaMaps';
import { parseGoogleMapsUrl } from '../lib/googleMapsLink';
import { checkFoodRelevance } from '../lib/contentModeration';
import { StarRatingInput } from './StarRating';
import MapView from './MapView';

type Props = {
  onClose: () => void;
  onPosted: () => void;
  initialCoords?: { lat: number; lon: number };
};

type LocationMode = 'current' | 'map' | 'search' | 'link';

const DEFAULT_CENTER: [number, number] = [77.5946, 12.9716];

export default function AddListingModal({ onClose, onPosted, initialCoords }: Props) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(initialCoords ?? null);
  const [locationMode, setLocationMode] = useState<LocationMode>('current');
  const [locating, setLocating] = useState(false);

  const [placeQuery, setPlaceQuery] = useState('');
  const [placeResults, setPlaceResults] = useState<PlaceSuggestion[]>([]);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [mapsLink, setMapsLink] = useState('');
  const [parsingLink, setParsingLink] = useState(false);

  const [pickedCenter, setPickedCenter] = useState<[number, number]>(DEFAULT_CENTER);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [addReview, setAddReview] = useState(false);
  const [reviewComment, setReviewComment] = useState('');
  const [foodQuality, setFoodQuality] = useState(5);
  const [hygiene, setHygiene] = useState(5);
  const [availability, setAvailability] = useState(5);
  const [maintenance, setMaintenance] = useState(5);

  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!placeQuery.trim()) {
      setPlaceResults([]);
      return;
    }
    searchDebounce.current = setTimeout(async () => {
      const results = await searchPlaces(placeQuery, coords ? { latitude: coords.lat, longitude: coords.lon } : undefined);
      setPlaceResults(results);
    }, 400);
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, [placeQuery]);

  function useCurrentLocation() {
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setLocating(false);
      },
      () => {
        setError('Could not get your location. Try another option below.');
        setLocating(false);
      }
    );
  }

  function selectPlace(place: PlaceSuggestion) {
    setCoords({ lat: place.latitude, lon: place.longitude });
    if (!name.trim()) setName(place.name);
    setPlaceQuery('');
    setPlaceResults([]);
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

  function confirmPickedLocation() {
    setCoords({ lat: pickedCenter[1], lon: pickedCenter[0] });
    setLocationMode('current');
  }

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  async function uploadPhoto(userId: string): Promise<{ url: string; path: string } | null> {
    if (!photoFile) return null;
    const ext = photoFile.name.split('.').pop() ?? 'jpg';
    const path = `${userId}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage.from('listing-photos').upload(path, photoFile, {
      contentType: photoFile.type || `image/${ext}`,
    });
    if (uploadError) return null;

    const { data } = supabase.storage.from('listing-photos').getPublicUrl(path);
    return { url: data.publicUrl, path };
  }

  async function submit() {
    setError(null);
    const priceNumber = Number(price);

    if (!name.trim()) return setError('Give this spot a name.');
    if (!priceNumber || priceNumber <= 0 || priceNumber > 100) return setError('Price must be ₹100 or under.');
    if (!coords) return setError('Set a location using one of the options below.');
    const foodCheck = checkFoodRelevance(name, note);
    if (!foodCheck.ok) {
      return setError(`Beggars Map is for cheap eats only — this looks like it might be about "${foodCheck.matchedTerm}" instead.`);
    }

    setSubmitting(true);
    try {
      const userId = await ensureAnonymousSession();
      if (!userId) {
        setError('Could not start a session. Please refresh and try again.');
        return;
      }

      const photo = await uploadPhoto(userId);

      const { data: inserted, error: insertError } = await supabase
        .from('listings')
        .insert({
          created_by: userId,
          name: name.trim(),
          price_rupees: priceNumber,
          note: note.trim() || null,
          photo_url: photo?.url ?? null,
          latitude: coords.lat,
          longitude: coords.lon,
        })
        .select('id')
        .single();

      if (insertError || !inserted) {
        // The listing never got created, so this upload is orphaned — clean
        // it up rather than leaving it in storage forever. Best-effort: if
        // this delete also fails, the original insert error is still what
        // gets shown to the user.
        if (photo) await supabase.storage.from('listing-photos').remove([photo.path]);
        setError(insertError?.message ?? 'Could not save listing.');
        return;
      }

      if (addReview) {
        const { error: reviewError } = await supabase.from('reviews').insert({
          listing_id: inserted.id,
          created_by: userId,
          comment: reviewComment.trim() || null,
          food_quality: foodQuality,
          hygiene,
          availability,
          maintenance,
        });
        // The listing itself is already saved — don't block closing the
        // modal on a review hiccup, just let the person know it happened.
        if (reviewError) window.alert('Listing posted, but your review could not be saved.');
      }

      onPosted();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
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
          <textarea className="text-input textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What's good here, timing, anything to know" />

          <label className="field-label">Photo (optional)</label>
          <div className="photo-picker" onClick={() => fileInputRef.current?.click()}>
            {photoPreview ? <img src={photoPreview} alt="" className="photo-preview" /> : <span>Choose a photo</span>}
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handlePhotoChange} style={{ display: 'none' }} />

          <label className="field-label">Location</label>
          {coords ? (
            <div className="pinned-banner">Pinned ✓ ({coords.lat.toFixed(4)}, {coords.lon.toFixed(4)})</div>
          ) : null}

          <div className="location-tabs">
            <button className={`tab-button ${locationMode === 'current' ? 'active' : ''}`} onClick={() => setLocationMode('current')}>Current</button>
            <button className={`tab-button ${locationMode === 'map' ? 'active' : ''}`} onClick={() => setLocationMode('map')}>Pick on map</button>
            <button className={`tab-button ${locationMode === 'search' ? 'active' : ''}`} onClick={() => setLocationMode('search')}>Search</button>
            <button className={`tab-button ${locationMode === 'link' ? 'active' : ''}`} onClick={() => setLocationMode('link')}>Paste link</button>
          </div>

          {locationMode === 'current' ? (
            <button className="secondary-button" onClick={useCurrentLocation} disabled={locating}>
              {locating ? 'Locating…' : 'Use my current location'}
            </button>
          ) : null}

          {locationMode === 'map' ? (
            <div className="pick-map-wrap">
              <MapView listings={[]} onSelectListing={() => {}} pickMode pickedCenter={pickedCenter} onPickedCenterChange={setPickedCenter} />
              <div className="pick-map-pin" />
              <button className="secondary-button" onClick={confirmPickedLocation}>Use this spot</button>
            </div>
          ) : null}

          {locationMode === 'search' ? (
            <div>
              <input className="text-input" value={placeQuery} onChange={(e) => setPlaceQuery(e.target.value)} placeholder="Search for the place" />
              {placeResults.length > 0 ? (
                <div className="results-list">
                  {placeResults.map((p) => (
                    <div key={p.placeId} className="result-row" onClick={() => selectPlace(p)}>
                      <div className="result-name">{p.name}</div>
                      {p.address ? <div className="result-address">{p.address}</div> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {locationMode === 'link' ? (
            <div className="link-row">
              <input className="text-input" value={mapsLink} onChange={(e) => setMapsLink(e.target.value)} placeholder="https://maps.app.goo.gl/..." />
              <button className="secondary-button" onClick={useMapsLink} disabled={parsingLink}>{parsingLink ? '…' : 'Use'}</button>
            </div>
          ) : null}

          <label className="field-label">Already tried it? (optional)</label>
          {!addReview ? (
            <button className="secondary-button" onClick={() => setAddReview(true)}>+ Leave a review too</button>
          ) : (
            <div className="review-form">
              <StarRatingInput label="Food quality" value={foodQuality} onChange={setFoodQuality} />
              <StarRatingInput label="Hygiene" value={hygiene} onChange={setHygiene} />
              <StarRatingInput label="Availability" value={availability} onChange={setAvailability} />
              <StarRatingInput label="Maintenance" value={maintenance} onChange={setMaintenance} />
              <input
                className="text-input"
                value={reviewComment}
                onChange={(e) => setReviewComment(e.target.value)}
                placeholder="Add a comment (optional)"
              />
              <button className="text-button" onClick={() => setAddReview(false)}>Never mind, skip the review</button>
            </div>
          )}

          {error ? <div className="error-text">{error}</div> : null}

          <button className="primary-button submit-button" onClick={submit} disabled={submitting}>
            {submitting ? 'Posting…' : addReview ? 'Post listing & review' : 'Post listing'}
          </button>
        </div>
      </div>
    </div>
  );
}
