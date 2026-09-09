import { useCallback, useEffect, useState } from 'react';
import { adminApi, ListingCorrection } from '../lib/adminApi';

type Props = {
  onViewHistory: (listingId: string) => void;
};

function formatDishes(dishes: { dish: string; price: number }[] | null): string {
  if (!dishes || dishes.length === 0) return '—';
  return dishes.map((d) => `${d.dish} ₹${d.price}`).join(', ');
}

// What this correction proposes to change, and what the listing currently
// has for that same field — a plain current -> proposed comparison, not a
// generic before/after diff (AuditStateView doesn't fit here: that compares
// two snapshots of the SAME row shape; this compares one field across two
// different rows — the correction's own proposal vs. the listing it targets).
function CorrectionDiff({ c }: { c: ListingCorrection }) {
  if (c.correction_type === 'name') {
    return (
      <div className="admin-correction-diff">
        <div>
          <strong>Current:</strong> {c.listings?.name ?? '—'}
        </div>
        <div>
          <strong>Proposed:</strong> {c.proposed_name}
        </div>
      </div>
    );
  }
  if (c.correction_type === 'dishes') {
    return (
      <div className="admin-correction-diff">
        <div>
          <strong>Current:</strong> {formatDishes(c.listings?.dishes ?? null)} (₹{c.listings?.price_rupees ?? '—'})
        </div>
        <div>
          <strong>Proposed:</strong> {formatDishes(c.proposed_dishes)}
        </div>
      </div>
    );
  }
  return (
    <div className="admin-correction-diff">
      <div>
        <strong>Current:</strong> {c.listings?.latitude.toFixed(4)}, {c.listings?.longitude.toFixed(4)}
        {c.listings?.location_label ? ` (${c.listings.location_label})` : ''}
      </div>
      <div>
        <strong>Proposed:</strong> {c.proposed_latitude?.toFixed(4)}, {c.proposed_longitude?.toFixed(4)}
        {c.proposed_location_label ? ` (${c.proposed_location_label})` : ''}
      </div>
    </div>
  );
}

export default function CorrectionsQueue({ onViewHistory }: Props) {
  const [corrections, setCorrections] = useState<ListingCorrection[]>([]);
  const [status, setStatus] = useState('pending');
  const [correctionType, setCorrectionType] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(() => {
    setError(null);
    adminApi
      .correctionsList(status, correctionType || undefined)
      .then((res) => setCorrections(res.data))
      .catch((err) => setError(err.message));
  }, [status, correctionType]);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(c: ListingCorrection) {
    setBusyKey(`${c.id}::approve`);
    setError(null);
    setMessage(null);
    try {
      await adminApi.correctionsApprove(c.id);
      setMessage(`Approved — ${c.listings?.name ?? c.listing_id} updated.`);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  function startReject(c: ListingCorrection) {
    setRejectingId(c.id);
    setRejectReason('');
    setError(null);
  }

  async function confirmReject(c: ListingCorrection) {
    if (!rejectReason.trim()) {
      setError('Enter a reason for rejecting this correction.');
      return;
    }
    setBusyKey(`${c.id}::reject`);
    setError(null);
    setMessage(null);
    try {
      await adminApi.correctionsReject(c.id, rejectReason.trim());
      setMessage(`Rejected — ${c.listings?.name ?? c.listing_id} left unchanged.`);
      setRejectingId(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div>
      <div className="admin-filters">
        <select className="admin-select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
        <select className="admin-select" value={correctionType} onChange={(e) => setCorrectionType(e.target.value)}>
          <option value="">All types</option>
          <option value="name">name</option>
          <option value="dishes">dishes</option>
          <option value="location">location</option>
        </select>
      </div>

      {error ? <p className="admin-error">{error}</p> : null}
      {message ? <p className="admin-success">{message}</p> : null}

      {corrections.length === 0 ? (
        <p>No corrections match these filters.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Listing</th>
                <th>Type</th>
                <th>Change</th>
                <th>Submitted by</th>
                <th>Note from submitter</th>
                <th>Submitted</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {corrections.map((c) => (
                <tr key={c.id}>
                  <td>{c.listings?.name ?? c.listing_id}</td>
                  <td>{c.correction_type}</td>
                  <td>
                    <CorrectionDiff c={c} />
                  </td>
                  <td>{c.profiles?.display_name ?? c.created_by}</td>
                  <td className="admin-correction-diff">{c.submitter_note ?? '—'}</td>
                  <td>{new Date(c.created_at).toLocaleString()}</td>
                  <td>
                    {c.status === 'pending' ? (
                      'Pending'
                    ) : (
                      <div className="admin-correction-diff">
                        <div>
                          {c.status}
                          {c.reviewed_by ? ` by ${c.reviewed_by}` : ''}
                        </div>
                        {c.reviewed_at ? <div>{new Date(c.reviewed_at).toLocaleString()}</div> : null}
                        {c.rejection_reason ? <div>&quot;{c.rejection_reason}&quot;</div> : null}
                      </div>
                    )}
                  </td>
                  <td className="admin-actions">
                    {c.status === 'pending' ? (
                      <>
                        <button
                          className="admin-button admin-button-small"
                          disabled={busyKey === `${c.id}::approve`}
                          onClick={() => approve(c)}
                        >
                          Approve
                        </button>
                        <button
                          className="admin-button admin-button-small admin-button-secondary"
                          disabled={busyKey === `${c.id}::reject`}
                          onClick={() => startReject(c)}
                        >
                          Reject
                        </button>
                      </>
                    ) : null}
                    <button className="admin-button admin-button-small admin-button-secondary" onClick={() => onViewHistory(c.listing_id)}>
                      History
                    </button>
                    {rejectingId === c.id ? (
                      <div className="admin-reject-inline">
                        <input
                          className="admin-input"
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder="Why is this being rejected?"
                        />
                        <button
                          className="admin-button admin-button-small"
                          disabled={busyKey === `${c.id}::reject`}
                          onClick={() => confirmReject(c)}
                        >
                          Confirm reject
                        </button>
                        <button className="admin-button admin-button-small admin-button-secondary" onClick={() => setRejectingId(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
