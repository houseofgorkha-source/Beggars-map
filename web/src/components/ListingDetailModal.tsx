import { useEffect, useState } from 'react';
import { supabase, ensureAnonymousSession } from '../lib/supabase';
import { StarRatingInput, StarRatingDisplay } from './StarRating';
import type { Listing, ListingRating, Review } from '../types';

type Props = {
  listingId: string;
  onClose: () => void;
};

const REPORT_REASONS = ["Closed / doesn't exist", 'Wrong price', 'Inappropriate photo', 'Spam or duplicate'];

export default function ListingDetailModal({ listingId, onClose }: Props) {
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

  async function load() {
    const { data: listingData } = await supabase.from('listings').select('*').eq('id', listingId).single();
    setListing(listingData as Listing);

    const { data: ratingData } = await supabase.from('listing_ratings').select('*').eq('listing_id', listingId).maybeSingle();
    setRating(ratingData as ListingRating | null);

    const { data: reviewData } = await supabase
      .from('reviews')
      .select('*')
      .eq('listing_id', listingId)
      .order('created_at', { ascending: false });
    setReviews((reviewData as Review[]) ?? []);

    const { count } = await supabase.from('votes').select('*', { count: 'exact', head: true }).eq('listing_id', listingId);
    setVoteCount(count ?? 0);

    const userId = await ensureAnonymousSession();
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
  }

  async function reportListing(reason: string) {
    const userId = await ensureAnonymousSession();
    if (!userId) return;
    await supabase.from('reports').insert({ listing_id: listingId, reported_by: userId, reason });
    setReporting(false);
  }

  function openDirections() {
    if (!listing) return;
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${listing.latitude},${listing.longitude}`, '_blank');
  }

  if (!listing) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <p className="loading-text">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
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
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
