import { useCallback, useEffect, useState } from 'react';
import { adminApi, ListingReview } from '../lib/adminApi';

type Props = {
  onOpenListing: (listingId: string) => void;
};

const PAGE_SIZE = 20;

// Global moderation view for community reviews (listing_reviews, 0022) —
// mirrors ReportsQueue's shape (list + one destructive action + busyKey/
// error/message state) plus AuditLog's pagination, since this is the one
// place reactive review moderation happens without already knowing which
// listing a reported review is on. A per-listing equivalent lives inside
// ListingDetail.tsx's own Reviews section, sharing the same reviewsDelete
// action and the same reason-required inline-confirm pattern
// CorrectionsQueue already established for Reject.
export default function ReviewsQueue({ onOpenListing }: Props) {
  const [reviews, setReviews] = useState<ListingReview[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteReason, setDeleteReason] = useState('');

  const load = useCallback(() => {
    setError(null);
    adminApi
      .reviewsList({ page, pageSize: PAGE_SIZE })
      .then((res) => {
        setReviews(res.data);
        setTotal(res.total);
      })
      .catch((err) => setError(err.message));
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  function startDelete(r: ListingReview) {
    setDeletingId(r.id);
    setDeleteReason('');
    setError(null);
  }

  async function confirmDelete(r: ListingReview) {
    if (!deleteReason.trim()) {
      setError('Enter a reason for deleting this review.');
      return;
    }
    setBusyKey(`${r.id}::delete`);
    setError(null);
    setMessage(null);
    try {
      await adminApi.reviewsDelete(r.id, deleteReason.trim());
      setMessage(`Deleted a review on ${r.listings?.name ?? r.listing_id}.`);
      setDeletingId(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      {error ? <p className="admin-error">{error}</p> : null}
      {message ? <p className="admin-success">{message}</p> : null}

      {reviews.length === 0 ? (
        <p>No reviews yet.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Listing</th>
                <th>Rating</th>
                <th>Review</th>
                <th>Photos</th>
                <th>Submitted by</th>
                <th>Submitted</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button className="admin-link" onClick={() => onOpenListing(r.listing_id)}>
                      {r.listings?.name ?? r.listing_id}
                    </button>
                  </td>
                  <td>{r.rating != null ? `${r.rating}★` : '—'}</td>
                  <td className="admin-correction-diff">{r.review_text ?? '—'}</td>
                  <td>{r.listing_review_photos.length}</td>
                  <td>{r.profiles?.display_name ?? r.created_by}</td>
                  <td>{new Date(r.created_at).toLocaleString()}</td>
                  <td className="admin-actions">
                    <button
                      className="admin-button admin-button-small admin-button-secondary"
                      disabled={busyKey === `${r.id}::delete`}
                      onClick={() => startDelete(r)}
                    >
                      Delete
                    </button>
                    {deletingId === r.id ? (
                      <div className="admin-reject-inline">
                        <input
                          className="admin-input"
                          value={deleteReason}
                          onChange={(e) => setDeleteReason(e.target.value)}
                          placeholder="Why is this being deleted?"
                        />
                        <button
                          className="admin-button admin-button-small"
                          disabled={busyKey === `${r.id}::delete`}
                          onClick={() => confirmDelete(r)}
                        >
                          Confirm delete
                        </button>
                        <button className="admin-button admin-button-small admin-button-secondary" onClick={() => setDeletingId(null)}>
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

      <div className="admin-pagination">
        <button className="admin-button admin-button-small admin-button-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {totalPages} ({total} total)
        </span>
        <button
          className="admin-button admin-button-small admin-button-secondary"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
