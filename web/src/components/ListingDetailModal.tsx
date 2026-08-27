import { useEffect, useState } from 'react';
import { supabase, ensureAnonymousSession } from '../lib/supabase';
import { StarRatingInput, StarRatingDisplay } from './StarRating';
import type { Listing, ListingRating, Review } from '../types';

type Props = {
  listingId: string;
  onClose: () => void;
  onUpdated?: () => void;
};

const REPORT_REASONS = ["Closed / doesn't exist", 'Wrong price', 'Inappropriate photo', 'Spam or duplicate'];

export default function ListingDetailModal({ listingId, onClose, onUpdated }: Props) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [rating, setRating] = useState<ListingRating | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [voteCount, setVoteCount] = useState(0);
  const [hasVoted, setHasVoted] = useState(false);
  const [comment, setComment] = useState('');
  const [foodQuality, setFoodQuality] = useState(5);
  const [hygiene, setHygiene] = useState(5);
  const [availability, setAvailability] = useState(5);
  const [maintenance, setMaintenance] = useState(5);
  const [reporting, setReporting] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  async function load() {
    // None of these depend on each other's results, so run them concurrently
    // instead of one round-trip after another.
    const [{ data: listingData, error: listingError }, { data: ratingData }, { data: reviewData }, { count }, userId] =
      await Promise.all([
        supabase.from('listings').select('*').eq('id', listingId).maybeSingle(),
        supabase.from('listing_ratings').select('*').eq('listing_id', listingId).maybeSingle(),
        supabase.from('reviews').select('*').eq('listing_id', listingId).order('created_at', { ascending: false }),
        supabase.from('votes').select('*', { count: 'exact', head: true }).eq('listing_id', listingId),
        ensureAnonymousSession(),
      ]);

    // A listing that's been deleted, or hidden by moderation (RLS filters it
    // out of public SELECT), comes back as no row rather than an error —
    // .maybeSingle() (not .single()) is what makes that "no row" case land
    // here as null instead of throwing, so we can tell it apart from "still
    // fetching" and show a real message instead of spinning forever.
    if (listingError || !listingData) {
      setNotFound(true);
      return;
    }

    setListing(listingData as Listing);
    setRating(ratingData as ListingRating | null);
    setReviews((reviewData as Review[]) ?? []);
    setVoteCount(count ?? 0);
    setMyUserId(userId);

    if (userId) {
      const { data: myVote } = await supabase
        .from('votes')
        .select('listing_id')
        .eq('listing_id', listingId)
        .eq('created_by', userId)
        .maybeSingle();
      setHasVoted(!!myVote);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId]);

  async function toggleVote() {
    const userId = await ensureAnonymousSession();
    if (!userId) return;

    if (hasVoted) {
      await supabase.from('votes').delete().eq('listing_id', listingId).eq('created_by', userId);
    } else {
      await supabase.from('votes').insert({ listing_id: listingId, created_by: userId });
    }
    load();
    onUpdated?.();
  }

  async function submitReview() {
    const userId = await ensureAnonymousSession();
    if (!userId) return;

    await supabase.from('reviews').upsert(
      {
        listing_id: listingId,
        created_by: userId,
        comment: comment.trim() || null,
        food_quality: foodQuality,
        hygiene,
        availability,
        maintenance,
      },
      { onConflict: 'listing_id,created_by' }
    );
    setComment('');
    load();
    onUpdated?.();
  }

  async function reportListing(reason: string) {
    const userId = await ensureAnonymousSession();
    if (!userId) {
      window.alert('Could not start a session. Please refresh and try again.');
      return;
    }
    const { error: reportError } = await supabase.from('reports').insert({ listing_id: listingId, reported_by: userId, reason });
    if (reportError) {
      if (reportError.code === '23505') {
        setReporting(false);
        window.alert("You've already reported this listing for that reason.");
        return;
      }
      window.alert(`Could not send report: ${reportError.message}`);
      return;
    }
    setReporting(false);
    window.alert('Thanks — this has been reported.');
  }

  async function deleteListing() {
    if (!listing) return;
    if (!window.confirm('Delete this listing? This removes it for everyone and cannot be undone.')) return;

    const { error } = await supabase.from('listings').delete().eq('id', listing.id);
    if (error) {
      window.alert(`Could not delete listing: ${error.message}`);
      return;
    }
    if (listing.photo_url) {
      const path = listing.photo_url.split('/listing-photos/')[1];
      if (path) await supabase.storage.from('listing-photos').remove([path]);
    }
    onUpdated?.();
    onClose();
  }

  async function deleteReview(reviewId: string) {
    if (!window.confirm('Delete your review? This cannot be undone.')) return;

    const { error } = await supabase.from('reviews').delete().eq('id', reviewId);
    if (error) {
      window.alert(`Could not delete review: ${error.message}`);
      return;
    }
    load();
    onUpdated?.();
  }

  function openDirections() {
    if (!listing) return;
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${listing.latitude},${listing.longitude}`, '_blank');
  }

  if (notFound) {
    return (
      <div className="listing-cover">
        <div className="modal-header">
          <h2>Not available</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="loading-text">This listing is no longer available.</p>
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="listing-cover">
        <p className="loading-text">Loading…</p>
      </div>
    );
  }

  return (
    <div className="listing-cover">
        <div className="modal-header">
          <h2>{listing.name}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body">
          {listing.photo_url ? <img src={listing.photo_url} alt={listing.name} className="detail-photo" /> : null}

          <div className="detail-price-row">
            <span className="detail-price">₹{listing.price_rupees}</span>
            {listing.note ? <span className="detail-note">{listing.note}</span> : null}
          </div>

          <StarRatingDisplay rating={rating?.avg_rating ?? null} count={rating?.rating_count ?? 0} />

          <div className="detail-actions">
            <button className={`vote-button ${hasVoted ? 'active' : ''}`} onClick={toggleVote}>
              ▲ Worth it ({voteCount})
            </button>
            <button className="secondary-button" onClick={openDirections}>Directions</button>
            <button className="report-button" onClick={() => setReporting(true)}>Report</button>
          </div>

          {myUserId && listing.created_by === myUserId ? (
            <button className="text-button delete-listing-button" onClick={deleteListing}>Delete my listing</button>
          ) : null}

          {reporting ? (
            <div className="report-panel">
              {REPORT_REASONS.map((reason) => (
                <button key={reason} className="secondary-button" onClick={() => reportListing(reason)}>
                  {reason}
                </button>
              ))}
              <button className="text-button" onClick={() => setReporting(false)}>Cancel</button>
            </div>
          ) : null}

          <h3 className="section-title">Reviews ({reviews.length})</h3>

          <div className="review-form">
            <StarRatingInput label="Food quality" value={foodQuality} onChange={setFoodQuality} />
            <StarRatingInput label="Hygiene" value={hygiene} onChange={setHygiene} />
            <StarRatingInput label="Availability" value={availability} onChange={setAvailability} />
            <StarRatingInput label="Maintenance" value={maintenance} onChange={setMaintenance} />
            <input className="text-input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment (optional)" />
            <button className="primary-button review-submit" onClick={submitReview}>Submit review</button>
          </div>

          {reviews.map((review) => {
            const reviewAvg = (review.food_quality + review.hygiene + review.availability + review.maintenance) / 4;
            return (
              <div key={review.id} className="review-card">
                <StarRatingDisplay rating={reviewAvg} count={1} small />
                {review.comment ? <div className="review-comment">{review.comment}</div> : null}
                {myUserId && review.created_by === myUserId ? (
                  <button className="text-button delete-review-button" onClick={() => deleteReview(review.id)}>Delete my review</button>
                ) : null}
              </div>
            );
          })}
        </div>
    </div>
  );
}
