import { useEffect, useState } from 'react';
import { discoverySupabase } from '../discoverySupabase';
import { discoveryApi, Candidate, Photo } from '../lib/discoveryApi';
import { validateDishDrafts, MIN_DISH_PRICE, MAX_DISH_PRICE, type DishDraft } from '../../lib/dishes';

const MAX_PHOTOS = 2;
const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

type Props = {
  candidate: Candidate;
  onSaved: (updated: Candidate) => void;
  onDirtyChange: (dirty: boolean) => void;
  onPrev: () => void;
  onNext: () => void;
};

// Rendered with key={candidate.place_id} by the parent, so a fresh instance
// (and fresh local state, initialized straight from `candidate` below) mounts
// on every selection change — no prop-sync effect needed.
export default function CandidateDetail({ candidate, onSaved, onDirtyChange, onPrev, onNext }: Props) {
  const [phone, setPhone] = useState(candidate.phone ?? '');
  const [numberValid, setNumberValid] = useState(candidate.number_valid ?? '');
  const [menuQualifies, setMenuQualifies] = useState(candidate.menu_list_under_100 ?? '');
  const [dishDrafts, setDishDrafts] = useState<DishDraft[]>(
    candidate.dishes && candidate.dishes.length > 0
      ? candidate.dishes.map((d) => ({ dish: d.dish, price: String(d.price) }))
      : [{ dish: '', price: '' }]
  );
  const [dishError, setDishError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const [photos, setPhotos] = useState<Photo[]>([]);
  const [photosLoading, setPhotosLoading] = useState(true);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    setPhotosLoading(true);
    discoveryApi
      .listPhotos(candidate.place_id)
      .then((res) => {
        if (!cancelled) setPhotos(res.data);
      })
      .catch((err) => {
        if (!cancelled) setPhotoError(err instanceof Error ? err.message : 'Could not load photos.');
      })
      .finally(() => {
        if (!cancelled) setPhotosLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [candidate.place_id]);

  function markDirty() {
    setDirty(true);
  }

  function updateDishDraft(index: number, patch: Partial<DishDraft>) {
    setDishDrafts((drafts) => drafts.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
    markDirty();
  }

  async function handleSave() {
    setSaveError(null);
    setDishError(null);

    const hasAnyDishInput = dishDrafts.some((d) => d.dish.trim() || d.price.trim());
    let dishesField: { dish: string; price: number }[] | null;

    if (hasAnyDishInput) {
      const dishCheck = validateDishDrafts(dishDrafts);
      if (!dishCheck.ok) {
        setDishError(dishCheck.error);
        return;
      }
      dishesField = dishCheck.entries;
    } else if (menuQualifies === 'Yes') {
      setDishError('Add at least one dish and its price — required when "Menu List Under 100" is Yes.');
      return;
    } else {
      dishesField = null;
    }

    setSaving(true);
    try {
      const res = await discoveryApi.update(candidate.place_id, {
        phone: phone.trim() || null,
        number_valid: numberValid || null,
        menu_list_under_100: menuQualifies || null,
        dishes: dishesField,
      });
      onSaved(res.data);
      setDirty(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  // Every photo add ultimately funnels here regardless of input method (file
  // picker, drag-drop, clipboard paste all hand over a File/Blob). Photos
  // are live/immediate, unlike phone/dropdowns/dishes above — there's no
  // "unsaved" state for a photo, since add/remove are each already a
  // complete round trip to Storage.
  async function uploadPhotoFile(file: File) {
    setPhotoError(null);
    if (photos.length >= MAX_PHOTOS) {
      setPhotoError(`Maximum ${MAX_PHOTOS} photos per candidate.`);
      return;
    }
    if (!ALLOWED_PHOTO_TYPES.includes(file.type)) {
      setPhotoError('Only JPEG, PNG, or WebP images are allowed.');
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError('Image is larger than 2MB.');
      return;
    }
    setPhotoBusy(true);
    try {
      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
      const { data } = await discoveryApi.createPhotoUploadUrl(candidate.place_id, `photo.${ext}`);
      const { error: uploadError } = await discoverySupabase.storage.from('discovery-photos').uploadToSignedUrl(data.path, data.token, file);
      if (uploadError) throw new Error(uploadError.message);
      const res = await discoveryApi.listPhotos(candidate.place_id);
      setPhotos(res.data);
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : 'Could not upload photo.');
    } finally {
      setPhotoBusy(false);
    }
  }

  // The only way to add a photo: right-click → Copy image on Google, then
  // click one of the two paste boxes below and paste (Ctrl+V). No file
  // picker, drag-drop, or URL input — one option, kept deliberately simple
  // for the intern workflow this screen is built around.
  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) uploadPhotoFile(file);
  }

  async function handleRemovePhoto(filename: string) {
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      await discoveryApi.removePhoto(candidate.place_id, filename);
      setPhotos((prev) => prev.filter((p) => p.name !== filename));
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : 'Could not remove photo.');
    } finally {
      setPhotoBusy(false);
    }
  }

  function guardedNav(action: () => void) {
    if (dirty && !window.confirm('You have unsaved changes. Discard them?')) return;
    action();
  }

  return (
    <div className="discovery-detail">
      <div className="discovery-detail-header">
        <h2>{candidate.name}</h2>
        <p className="admin-muted">{candidate.formatted_address ?? 'No address on file'}</p>
        <a
          href={`https://www.google.com/search?q=${encodeURIComponent(
            [candidate.name, candidate.formatted_address].filter(Boolean).join(' ')
          )}`}
          target="_blank"
          rel="noreferrer"
          className="admin-link"
        >
          Open in Google Search
        </a>
      </div>

      <div className="admin-field">
        <label className="field-label">Phone</label>
        <input
          className="admin-input text-input"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            markDirty();
          }}
        />
      </div>

      <div className="admin-field">
        <label className="field-label">Number Valid</label>
        <select
          className="admin-select"
          value={numberValid}
          onChange={(e) => {
            setNumberValid(e.target.value as typeof numberValid);
            markDirty();
          }}
        >
          <option value="">—</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
          <option value="No Answer">No Answer</option>
        </select>
      </div>

      <div className="admin-field">
        <label className="field-label">Menu List Under 100</label>
        <select
          className="admin-select"
          value={menuQualifies}
          onChange={(e) => {
            setMenuQualifies(e.target.value as typeof menuQualifies);
            markDirty();
          }}
        >
          <option value="">—</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
      </div>

      {/* Dish + Price rows — same JSX/classes/behavior as the real site's
          Add Listing form (web/src/components/AddListingModal.tsx), reused
          verbatim so the intern's research workflow looks and behaves
          exactly like the listing form it's feeding into. */}
      {dishDrafts.map((draft, index) => (
        <div className="dish-entry" key={index}>
          {index > 0 ? (
            <button
              type="button"
              className="dish-remove"
              onClick={() => {
                setDishDrafts((drafts) => drafts.filter((_, i) => i !== index));
                markDirty();
              }}
              aria-label={`Remove dish ${index + 1}`}
            >
              ✕
            </button>
          ) : null}
          <div className="dish-price-labels">
            <label className="field-label dish-label">Dish{index === 0 ? ' (at least one required if qualifying)' : ''}</label>
            <label className="field-label price-label">Price (₹ per plate)*</label>
          </div>
          <div className="dish-price-row">
            <div className="dish-field">
              <input
                className="text-input"
                value={draft.dish}
                onChange={(e) => updateDishDraft(index, { dish: e.target.value })}
                placeholder="e.g. Masala Dosa"
              />
            </div>
            <div className="price-field">
              <input
                className="text-input"
                value={draft.price}
                onChange={(e) => updateDishDraft(index, { price: e.target.value })}
                placeholder="60"
                type="number"
                min={MIN_DISH_PRICE}
                max={MAX_DISH_PRICE}
              />
            </div>
          </div>
        </div>
      ))}
      <div className="dish-price-row">
        <div className="dish-field" />
        <div className="price-field">
          <span className="field-hint">
            *₹{MIN_DISH_PRICE}-₹{MAX_DISH_PRICE}
          </span>
        </div>
      </div>
      <button
        type="button"
        className="dish-add-more"
        onClick={() => {
          setDishDrafts((drafts) => [...drafts, { dish: '', price: '' }]);
          markDirty();
        }}
      >
        + Add more
      </button>
      {dishError ? <div className="error-text">{dishError}</div> : null}

      <div className="discovery-photos">
        <label className="field-label">Photos ({photos.length}/{MAX_PHOTOS})</label>
        {photosLoading ? (
          <p className="admin-muted">Loading photos…</p>
        ) : (
          <div className="admin-photo-grid">
            {Array.from({ length: MAX_PHOTOS }, (_, slot) => {
              const photo = photos[slot];
              if (photo) {
                return (
                  <div key={photo.name} className="discovery-photo-thumb">
                    <a href={photo.url} target="_blank" rel="noreferrer">
                      <img src={photo.url} alt="" className="admin-photo-thumb" />
                    </a>
                    <button
                      type="button"
                      className="photo-thumb-remove"
                      onClick={() => handleRemovePhoto(photo.name)}
                      disabled={photoBusy}
                      aria-label="Remove photo"
                    >
                      ✕
                    </button>
                  </div>
                );
              }
              return (
                <div key={slot} className="discovery-photo-paste-box" tabIndex={0} onPaste={handlePaste}>
                  {photoBusy ? 'Uploading…' : 'Click here, then paste (Ctrl+V)'}
                </div>
              );
            })}
          </div>
        )}
        {photoError ? <div className="error-text">{photoError}</div> : null}
      </div>

      {saveError ? <p className="admin-error">{saveError}</p> : null}

      <div className="discovery-detail-footer">
        <span className={dirty ? 'discovery-dirty' : 'admin-muted'}>{dirty ? '● Unsaved changes' : 'Saved'}</span>
        <button className="admin-button" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="discovery-detail-nav">
        <button className="admin-button admin-button-secondary" onClick={() => guardedNav(onPrev)}>
          {'< Prev unreviewed'}
        </button>
        <button className="admin-button admin-button-secondary" onClick={() => guardedNav(onNext)}>
          {'Next unreviewed >'}
        </button>
      </div>
    </div>
  );
}
