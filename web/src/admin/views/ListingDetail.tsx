import { useCallback, useEffect, useState } from 'react';
import { adminApi, AuditEntry, Listing, ListingPhoto } from '../lib/adminApi';
import AuditStateView from '../components/AuditStateView';

type Props = {
  listingId: string;
  onBack: () => void;
};

type EditableFields = {
  name: string;
  price_rupees: string;
  note: string;
  latitude: string;
  longitude: string;
  location_label: string;
  verification_status: string;
  evidence_url: string;
  evidence_date: string;
};

function toEditable(listing: Listing): EditableFields {
  return {
    name: listing.name,
    price_rupees: String(listing.price_rupees),
    note: listing.note ?? '',
    latitude: String(listing.latitude),
    longitude: String(listing.longitude),
    location_label: listing.location_label ?? '',
    verification_status: listing.verification_status,
    evidence_url: listing.evidence_url ?? '',
    evidence_date: listing.evidence_date ?? '',
  };
}

export default function ListingDetail({ listingId, onBack }: Props) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [photos, setPhotos] = useState<ListingPhoto[]>([]);
  const [auditHistory, setAuditHistory] = useState<AuditEntry[]>([]);
  const [fields, setFields] = useState<EditableFields | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    adminApi
      .listingsGet(listingId)
      .then((res) => {
        setListing(res.data.listing);
        setPhotos(res.data.photos);
        setAuditHistory(res.data.auditHistory);
        setFields(toEditable(res.data.listing));
      })
      .catch((err) => setError(err.message));
  }, [listingId]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!fields) return;
    setBusy('save');
    setError(null);
    setSaveMessage(null);
    try {
      const price = Number(fields.price_rupees);
      const lat = Number(fields.latitude);
      const lng = Number(fields.longitude);
      if (!Number.isFinite(price) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new Error('Price/latitude/longitude must be valid numbers');
      }
      await adminApi.listingsUpdate(listingId, {
        name: fields.name,
        price_rupees: price,
        note: fields.note || null,
        latitude: lat,
        longitude: lng,
        location_label: fields.location_label || null,
        verification_status: fields.verification_status,
        evidence_url: fields.evidence_url || null,
        evidence_date: fields.evidence_date || null,
      });
      setSaveMessage('Saved.');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runAction(action: 'hide' | 'unhide' | 'archive' | 'unarchive' | 'markReviewed' | 'markUnreviewed') {
    setBusy(action);
    setError(null);
    setSaveMessage(null);
    try {
      const fn = {
        hide: adminApi.listingsHide,
        unhide: adminApi.listingsUnhide,
        archive: adminApi.listingsArchive,
        unarchive: adminApi.listingsUnarchive,
        markReviewed: adminApi.listingsMarkReviewed,
        markUnreviewed: adminApi.listingsMarkUnreviewed,
      }[action];
      await fn(listingId);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error && !listing) {
    return (
      <div>
        <button className="admin-button admin-button-secondary admin-button-small" onClick={onBack}>
          ← Back to listings
        </button>
        <p className="admin-error">{error}</p>
      </div>
    );
  }

  if (!listing || !fields) return <p>Loading…</p>;

  return (
    <div>
      <div className="admin-section-header">
        <button className="admin-button admin-button-secondary admin-button-small" onClick={onBack}>
          ← Back to listings
        </button>
        <div className="admin-badges">
          {listing.isNew ? <span className="admin-badge admin-badge-new">NEW</span> : null}
          <span className={`admin-badge admin-badge-source-${listing.source}`}>{listing.source}</span>
          {listing.archived_at ? <span className="admin-badge admin-badge-archived">Archived</span> : null}
          {listing.is_hidden ? <span className="admin-badge admin-badge-hidden">Hidden</span> : null}
          {!listing.is_hidden && !listing.archived_at ? <span className="admin-badge admin-badge-visible">Visible</span> : null}
        </div>
      </div>

      <h2 className="admin-detail-title">
        {listing.isNew ? <span className="admin-new-dot" title="New — not yet reviewed" /> : null}
        {listing.name}
      </h2>

      {error ? <p className="admin-error">{error}</p> : null}
      {saveMessage ? <p className="admin-success">{saveMessage}</p> : null}

      {photos.length > 0 || listing.photo_url ? (
        <div className="admin-photo-grid">
          {(listing.photo_url && !photos.some((p) => p.photo_url === listing.photo_url)
            ? [{ id: 'cover', photo_url: listing.photo_url }, ...photos]
            : photos
          ).map((p) => (
            <a key={p.id} href={p.photo_url} target="_blank" rel="noreferrer">
              <img src={p.photo_url} alt="" className="admin-photo-thumb" />
            </a>
          ))}
        </div>
      ) : (
        <p className="admin-muted">No photos.</p>
      )}

      <div className="admin-detail-grid">
        <div className="admin-section">
          <h3>Details</h3>
          <label className="admin-field">
            Name
            <input className="admin-input" value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} />
          </label>
          <label className="admin-field">
            Price (₹)
            <input
              className="admin-input"
              type="number"
              value={fields.price_rupees}
              onChange={(e) => setFields({ ...fields, price_rupees: e.target.value })}
            />
          </label>
          <label className="admin-field">
            Note
            <textarea className="admin-textarea" value={fields.note} onChange={(e) => setFields({ ...fields, note: e.target.value })} />
          </label>
          <label className="admin-field">
            Latitude
            <input
              className="admin-input"
              value={fields.latitude}
              onChange={(e) => setFields({ ...fields, latitude: e.target.value })}
            />
          </label>
          <label className="admin-field">
            Longitude
            <input
              className="admin-input"
              value={fields.longitude}
              onChange={(e) => setFields({ ...fields, longitude: e.target.value })}
            />
          </label>
          <label className="admin-field">
            Location label
            <input
              className="admin-input"
              value={fields.location_label}
              onChange={(e) => setFields({ ...fields, location_label: e.target.value })}
            />
          </label>

          <h3>Evidence &amp; verification</h3>
          <label className="admin-field">
            Verification status
            <select
              className="admin-select"
              value={fields.verification_status}
              onChange={(e) => setFields({ ...fields, verification_status: e.target.value })}
            >
              <option value="unverified">unverified</option>
              <option value="pending_review">pending_review</option>
              <option value="human_verified">human_verified</option>
              <option value="rejected">rejected</option>
            </select>
          </label>
          <label className="admin-field">
            Evidence URL
            <input
              className="admin-input"
              value={fields.evidence_url}
              onChange={(e) => setFields({ ...fields, evidence_url: e.target.value })}
              placeholder="https://…"
            />
          </label>
          <label className="admin-field">
            Evidence date
            <input
              className="admin-input"
              type="date"
              value={fields.evidence_date}
              onChange={(e) => setFields({ ...fields, evidence_date: e.target.value })}
            />
          </label>
          <p className="admin-muted admin-hint">
            Evidence date is when the underlying research was gathered — leave blank if unknown. It is never the same
            as "created" below.
          </p>

          <button className="admin-button" disabled={busy === 'save'} onClick={save}>
            Save changes
          </button>
        </div>

        <div className="admin-section">
          <h3>Provenance</h3>
          <dl className="admin-dl">
            <dt>Source</dt>
            <dd>{listing.source}</dd>
            <dt>Actor type</dt>
            <dd>{listing.actor_type}</dd>
            <dt>Actor label</dt>
            <dd>{listing.actor_label ?? '—'}</dd>
            <dt>Created by (profile id)</dt>
            <dd className="admin-mono">{listing.created_by}</dd>
            <dt>Created at</dt>
            <dd>{new Date(listing.created_at).toLocaleString()}</dd>
            <dt>Last updated</dt>
            <dd>{new Date(listing.updated_at).toLocaleString()}</dd>
            <dt>Last modified by (admin)</dt>
            <dd>{listing.last_modified_by ?? '— (never edited by an admin)'}</dd>
            <dt>Review status</dt>
            <dd>
              {listing.reviewed_at
                ? `Reviewed ${new Date(listing.reviewed_at).toLocaleString()} by ${listing.reviewed_by ?? '—'}`
                : listing.isNew
                  ? 'Not yet reviewed'
                  : 'Not yet reviewed (predates review tracking — not flagged as new)'}
            </dd>
          </dl>

          {/* Stage 2A location provenance (0015). Display-only here — this
              is the evidence foundation, not the verification workflow, so
              there is deliberately no edit control or "verify" action yet.
              'unknown'/'unknown' on a pre-existing listing is the honest,
              expected state, not a warning sign. */}
          <h3>Location provenance</h3>
          <dl className="admin-dl">
            <dt>Location source</dt>
            <dd>{listing.location_source}</dd>
            <dt>Location confidence</dt>
            <dd>{listing.location_confidence}</dd>
            <dt>Location verified</dt>
            <dd>
              {listing.location_verified_at
                ? `${new Date(listing.location_verified_at).toLocaleString()} by ${listing.location_verified_by ?? '—'}`
                : '— (never independently confirmed)'}
            </dd>
            <dt>Provider place IDs</dt>
            <dd>
              {Object.keys(listing.provider_place_ids).length === 0 ? (
                '— (none recorded)'
              ) : (
                <ul className="admin-provider-ids">
                  {Object.entries(listing.provider_place_ids).map(([provider, id]) => (
                    <li key={provider} className="admin-mono">
                      {provider}: {id}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>

          <h3>Moderation</h3>
          <div className="admin-actions">
            <button className="admin-button admin-button-small" disabled={busy === 'hide' || listing.is_hidden} onClick={() => runAction('hide')}>
              Hide
            </button>
            <button
              className="admin-button admin-button-small"
              disabled={busy === 'unhide' || !listing.is_hidden}
              onClick={() => runAction('unhide')}
            >
              Unhide
            </button>
            <button
              className="admin-button admin-button-small admin-button-secondary"
              disabled={busy === 'archive' || !!listing.archived_at}
              onClick={() => runAction('archive')}
            >
              Archive
            </button>
            <button
              className="admin-button admin-button-small admin-button-secondary"
              disabled={busy === 'unarchive' || !listing.archived_at}
              onClick={() => runAction('unarchive')}
            >
              Unarchive
            </button>
            <button
              className="admin-button admin-button-small"
              disabled={busy === 'markReviewed' || !!listing.reviewed_at}
              onClick={() => runAction('markReviewed')}
            >
              Mark reviewed
            </button>
            <button
              className="admin-button admin-button-small admin-button-secondary"
              disabled={busy === 'markUnreviewed' || !listing.reviewed_at}
              onClick={() => runAction('markUnreviewed')}
            >
              Mark unreviewed
            </button>
          </div>
          <p className="admin-muted admin-hint">
            Archiving also hides the listing. Unarchiving does not restore visibility — Unhide separately if it should
            go back live. Opening this page never marks a listing reviewed by itself — only the explicit button does.
          </p>

          <h3>History for this listing</h3>
          {auditHistory.length === 0 ? (
            <p className="admin-muted">No admin actions recorded yet.</p>
          ) : (
            <ul className="admin-history-list">
              {auditHistory.map((entry) => (
                <li key={entry.id}>
                  <div>
                    <strong>{entry.action}</strong> by {entry.actor_label} — {new Date(entry.created_at).toLocaleString()}
                  </div>
                  <AuditStateView beforeState={entry.before_state} afterState={entry.after_state} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
