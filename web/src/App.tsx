import { useCallback, useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import MapView from './components/MapView';
import AddListingModal from './components/AddListingModal';
import ListingDetailModal from './components/ListingDetailModal';
import { StarRatingDisplay } from './components/StarRating';
import LegalModal from './components/LegalModal';
import AboutContent from './components/AboutContent';
import AboutModal from './components/AboutModal';
import type { Listing, ListingRating } from './types';

type ListingWithVotes = Listing & { voteCount: number; avgRating: number | null; ratingCount: number };

export default function App() {
  const [listings, setListings] = useState<ListingWithVotes[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addInitialCoords, setAddInitialCoords] = useState<{ lat: number; lon: number } | undefined>(undefined);
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [legalTab, setLegalTab] = useState<'privacy' | 'terms' | null>(null);
  const [showAbout, setShowAbout] = useState(false);

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
    setAddInitialCoords(undefined);
    load();
  }

  function handleMapClick(latitude: number, longitude: number) {
    setAddInitialCoords({ lat: latitude, lon: longitude });
    setShowAdd(true);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand">Beggars Map</div>
          <div className="brand-sub">Cheap eats in Bengaluru, ₹100 or under</div>
        </div>
        <button className="about-button" onClick={() => setShowAbout(true)}>About Us</button>
      </header>

      <div className="coming-soon-banner">Launching soon in Delhi, Mumbai, Kolkata, Chennai, Guwahati and more</div>

      <main className="main">
        <section className="about-panel">
          <AboutContent />
        </section>

        <div className="map-panel">
          <div className="map-toolbar">
            <select className="city-select" value="Bengaluru" onChange={() => {}}>
              <option value="Bengaluru">Bengaluru</option>
              <option value="Delhi" disabled>Delhi (coming soon)</option>
              <option value="Mumbai" disabled>Mumbai (coming soon)</option>
              <option value="Kolkata" disabled>Kolkata (coming soon)</option>
              <option value="Chennai" disabled>Chennai (coming soon)</option>
              <option value="Guwahati" disabled>Guwahati (coming soon)</option>
            </select>
            <input
              className="search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search cheap eats"
            />
            <button className="primary-button contribute-button" onClick={() => setShowAdd(true)}>+ Contribute</button>
          </div>
          <div className="map-frame">
            <div className="map-click-hint">Click the map to add a spot</div>
            <MapView
              listings={filtered}
              onSelectListing={setSelectedListingId}
              showLocate
              selectedListing={listings.find((l) => l.id === selectedListingId) ?? null}
              onMapClick={handleMapClick}
            />
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

          {selectedListingId ? (
            <ListingDetailModal listingId={selectedListingId} onClose={() => setSelectedListingId(null)} onUpdated={load} />
          ) : null}
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

      {showAdd ? (
        <AddListingModal
          onClose={() => {
            setShowAdd(false);
            setAddInitialCoords(undefined);
          }}
          onPosted={handlePosted}
          initialCoords={addInitialCoords}
        />
      ) : null}
      {legalTab ? <LegalModal initialTab={legalTab} onClose={() => setLegalTab(null)} /> : null}
      {showAbout ? <AboutModal onClose={() => setShowAbout(false)} /> : null}
    </div>
  );
}
