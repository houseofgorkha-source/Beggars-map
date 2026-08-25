import { useCallback, useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import MapView from './components/MapView';
import AddListingModal from './components/AddListingModal';
import ListingDetailModal from './components/ListingDetailModal';
import { StarRatingDisplay } from './components/StarRating';
import LegalModal from './components/LegalModal';
import type { Listing, ListingRating } from './types';

type ListingWithVotes = Listing & { voteCount: number; avgRating: number | null; ratingCount: number };

export default function App() {
  const [listings, setListings] = useState<ListingWithVotes[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [legalTab, setLegalTab] = useState<'privacy' | 'terms' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [{ data, error }, { data: ratingsData }] = await Promise.all([
      supabase.from('listings').select('*, votes(count)').order('price_rupees', { ascending: true }),
      supabase.from('listing_ratings').select('*'),
    ]);
    if (error || !data) {
      setLoadError("Couldn't load listings. Check your connection and try again.");
      setLoading(false);
      return;
    }
    const ratingsByListing = new Map((ratingsData as ListingRating[] | null)?.map((r) => [r.listing_id, r]));
    setListings(
      data.map((row: any) => {
        const rating = ratingsByListing.get(row.id);
        return {
          ...row,
          voteCount: row.votes?.[0]?.count ?? 0,
          avgRating: rating?.avg_rating ?? null,
          ratingCount: rating?.rating_count ?? 0,
        };
      })
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = listings.filter((l) => l.name.toLowerCase().includes(query.toLowerCase()));

  function handlePosted() {
    setShowAdd(false);
    load();
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Beggars Map</div>
        <div className="brand-sub">Cheap eats in Bengaluru, ₹100 or under</div>
        <input
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search cheap eats"
        />
        <button className="primary-button contribute-button" onClick={() => setShowAdd(true)}>+ Contribute</button>
      </header>

      <div className="coming-soon-banner">Launching soon in Delhi, Mumbai, Kolkata, Chennai, Guwahati and more</div>

      <main className="main">
        <section className="about-panel">
          <h1>About Beggars Map</h1>
          <p className="about-lead">A community-driven directory of affordable meals in Bengaluru — every listing capped at ₹100, because a good meal shouldn't be a luxury.</p>
          <p className="about-body">When an economy turns hard, it's the people who can least afford it who go hungry first — some lose their homes, some skip meals entirely. We believe everyone deserves at least one proper meal a day, and finding one shouldn't take a miracle.</p>
          <p className="about-body">That's where you come in. Add the spots you know, and rate the ones you've tried — so the whole community knows exactly where ₹100 goes furthest.</p>
          <p className="about-body">We have no partnerships or deals with any vendor or restaurant — every listing here is purely organic, added by people like you, not paid for by anyone.</p>
          <p className="about-body">Our founder still insists 1 rupee is 100 paisa. A reminder that every coin counts, and so does every listing you add.</p>
        </section>

        <div className="map-panel">
          <div className="map-frame">
            <MapView listings={filtered} onSelectListing={setSelectedListingId} showLocate />
          </div>
        </div>

        <aside className="list-panel">
          {loading && listings.length === 0 ? (
            <div className="state-block">
              <span className="spinner" aria-hidden="true" />
              <p className="loading-text">Loading cheap eats…</p>
            </div>
          ) : null}
          {!loading && loadError ? (
            <div className="state-block">
              <p className="error-text state-error-text">{loadError}</p>
              <button className="secondary-button" onClick={load}>Retry</button>
            </div>
          ) : null}
          {!loading && !loadError && filtered.length === 0 ? (
            <p className="loading-text">
              {listings.length === 0 ? 'No listings yet. Be the first to add one.' : 'No listings match your search.'}
            </p>
          ) : null}
          {filtered.map((listing) => (
            <div key={listing.id} className="list-card" onClick={() => setSelectedListingId(listing.id)}>
              <div className="list-card-header">
                <span className="list-card-name">{listing.name}</span>
                <span className="list-card-price">₹{listing.price_rupees}</span>
              </div>
              <StarRatingDisplay rating={listing.avgRating} count={listing.ratingCount} small />
              {listing.note ? <p className="list-card-note">{listing.note}</p> : null}
              <span className="list-card-votes">▲ {listing.voteCount}</span>
            </div>
          ))}
        </aside>
      </main>

      <footer className="footer">
        <a className="footer-link" href="tel:+919606002439">Call +91 96060 02439</a>
        <span className="footer-dot">·</span>
        <a className="footer-link" href="https://wa.me/919606002439" target="_blank" rel="noreferrer">WhatsApp us</a>
        <span className="footer-dot">·</span>
        <button className="footer-link footer-link-button" onClick={() => setLegalTab('privacy')}>Privacy Policy</button>
        <span className="footer-dot">·</span>
        <button className="footer-link footer-link-button" onClick={() => setLegalTab('terms')}>Terms &amp; Conditions</button>
      </footer>

      {showAdd ? <AddListingModal onClose={() => setShowAdd(false)} onPosted={handlePosted} /> : null}
      {selectedListingId ? <ListingDetailModal listingId={selectedListingId} onClose={() => setSelectedListingId(null)} /> : null}
      {legalTab ? <LegalModal initialTab={legalTab} onClose={() => setLegalTab(null)} /> : null}
    </div>
  );
}
