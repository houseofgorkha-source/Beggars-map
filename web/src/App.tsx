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
          <p className="about-lead">A community of people who know that a great meal doesn't have to cost a fortune. Every listing is ₹100 or less.</p>
          <p className="about-body">We call ourselves the Beggars because we believe in asking a simple question: <strong>where does ₹100 go furthest?</strong></p>
          <p className="about-body">Bengaluru is full of places serving honest, satisfying food at prices that make sense. The problem isn't always finding food. It's finding the <strong>good stuff</strong> without spending half your wallet discovering it.</p>
          <p className="about-body">That's where Beggars Map comes in.</p>
          <p className="about-body">We share the places we know, rate the food we've tried, and help each other discover meals worth every rupee. No fancy marketing. No paid rankings. Just people sharing what they've found.</p>
          <p className="about-body"><strong>No partnerships. No sponsored listings. No paid placements.</strong> Every spot on Beggars Map comes from the community, and the community decides what deserves attention.</p>
          <p className="about-body">Because ₹100 is ₹100. Whether you're a student, a traveller, a working professional, or simply someone who refuses to overpay for lunch, <strong>every rupee counts.</strong></p>
          <p className="about-tagline">Find it. Eat it. Rate it. Pass it on.</p>
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
        <span className="footer-text">App Store: Coming soon</span>
        <span className="footer-dot">·</span>
        <span className="footer-text">Play Store: Coming soon</span>
        <span className="footer-dot">·</span>
        <button className="footer-link footer-link-button" onClick={() => setLegalTab('privacy')}>Privacy Policy</button>
        <span className="footer-dot">·</span>
        <button className="footer-link footer-link-button" onClick={() => setLegalTab('terms')}>Terms &amp; Conditions</button>
      </footer>

      {showAdd ? <AddListingModal onClose={() => setShowAdd(false)} onPosted={handlePosted} /> : null}
      {selectedListingId ? (
        <ListingDetailModal listingId={selectedListingId} onClose={() => setSelectedListingId(null)} onUpdated={load} />
      ) : null}
      {legalTab ? <LegalModal initialTab={legalTab} onClose={() => setLegalTab(null)} /> : null}
    </div>
  );
}
