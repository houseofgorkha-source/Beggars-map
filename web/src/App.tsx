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
  const [showAdd, setShowAdd] = useState(false);
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [legalTab, setLegalTab] = useState<'privacy' | 'terms' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data, error }, { data: ratingsData }] = await Promise.all([
      supabase.from('listings').select('*, votes(count)').order('price_rupees', { ascending: true }),
      supabase.from('listing_ratings').select('*'),
    ]);
    if (!error && data) {
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
    }
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

      <main className="main">
        <section className="about-panel">
          <h1>About Beggars Map</h1>
          <p className="about-placeholder">Intro copy goes here.</p>
        </section>

        <div className="map-panel">
          <div className="map-frame">
            <MapView listings={filtered} onSelectListing={setSelectedListingId} />
          </div>
        </div>

        <aside className="list-panel">
          {loading && filtered.length === 0 ? <p className="loading-text">Loading…</p> : null}
          {!loading && filtered.length === 0 ? <p className="loading-text">No listings yet. Be the first to add one.</p> : null}
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
        <div className="footer-section">
          <span className="footer-heading">Support</span>
          <p className="footer-placeholder">Support content goes here.</p>
        </div>
        <div className="footer-section">
          <span className="footer-heading">Contact us</span>
          <a className="footer-link" href="tel:+919606002439">Call +91 96060 02439</a>
          <a className="footer-link" href="https://wa.me/919606002439" target="_blank" rel="noreferrer">WhatsApp us</a>
        </div>
        <div className="footer-section">
          <span className="footer-heading">Legal</span>
          <button className="footer-link footer-link-button" onClick={() => setLegalTab('privacy')}>Privacy Policy</button>
          <button className="footer-link footer-link-button" onClick={() => setLegalTab('terms')}>Terms &amp; Conditions</button>
        </div>
      </footer>

      {showAdd ? <AddListingModal onClose={() => setShowAdd(false)} onPosted={handlePosted} /> : null}
      {selectedListingId ? <ListingDetailModal listingId={selectedListingId} onClose={() => setSelectedListingId(null)} /> : null}
      {legalTab ? <LegalModal initialTab={legalTab} onClose={() => setLegalTab(null)} /> : null}
    </div>
  );
}
