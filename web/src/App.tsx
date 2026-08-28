import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { supabase } from './lib/supabase';
import { searchPlaces, type PlaceSuggestion } from './lib/olaPlaces';
import { formatRelativeTime } from './lib/relativeTime';
import MapView from './components/MapView';
import Logo from './components/Logo';
import AddListingModal from './components/AddListingModal';
import ListingDetailModal from './components/ListingDetailModal';
import LegalModal from './components/LegalModal';
import AboutContent from './components/AboutContent';
import AboutModal from './components/AboutModal';
import type { Listing } from './types';

type ListingWithVotes = Listing & { voteCount: number };

const CITIES = ['Bengaluru', 'Delhi', 'Mumbai', 'Kolkata', 'Chennai', 'Guwahati'];

// Mirrors styles.css's combined mobile media query (portrait width OR
// mobile landscape — a rotated phone commonly reports widths well above
// 720px, which plain width-based JS checks below used to miss). Kept as
// one shared string so the CSS and JS "is this mobile?" answers can't
// drift apart.
const MOBILE_MEDIA_QUERY = '(max-width: 720px), (hover: none) and (pointer: coarse) and (max-height: 500px)';

// The mobile bottom sheet's three snap states, as a fraction of the map
// frame's own height — clamped in computeSheetSnaps below so extreme
// container heights (a very short phone-landscape frame, say) can't
// invert the ordering or collapse a state down to nothing.
type SheetState = 'collapsed' | 'partial' | 'expanded';

function computeSheetSnaps(containerHeight: number) {
  const collapsed = Math.round(Math.max(96, Math.min(150, containerHeight * 0.22)));
  const expanded = Math.round(Math.max(collapsed + 80, containerHeight * 0.86));
  // 150px floor (not just collapsed + 40) keeps "partial" at or above
  // .listing-cover's own 140px CSS min-height on very short (phone
  // landscape) frames — otherwise a selection auto-expanding into
  // "partial" could hand the detail card less room than its own floor
  // demands, forcing a few px of overflow out of the sheet.
  const partial = Math.round(Math.max(150, collapsed + 40, Math.min(expanded - 40, containerHeight * 0.48)));
  return { collapsed, partial, expanded };
}

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

  const [placeResults, setPlaceResults] = useState<PlaceSuggestion[]>([]);
  const [searchResultsOpen, setSearchResultsOpen] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultsRef = useRef<HTMLDivElement>(null);
  const listPanelRef = useRef<HTMLDivElement>(null);
  const overlayRowRef = useRef<HTMLDivElement>(null);
  const coverRef = useRef<HTMLDivElement>(null);
  // The clicked list-card's on-screen top position, captured right before
  // selecting it — used to animate the detail card "flying" up from that
  // exact spot into place at the top, instead of just popping into
  // existence, so it's visually clear the card the user clicked is the one
  // that moved (see the layout effect below). null when selection came
  // from a map marker instead, where there's no list position to fly from.
  // A ref, not state — the layout effect below clears it after reading it,
  // and doing that via setState would re-trigger the same effect and
  // cancel its own cleanup timeout before the animation finished.
  const flyFromTopRef = useRef<number | null>(null);
  // The list panel's hard top boundary needs to land exactly on the
  // search/Contribute row's real rendered bottom edge — not a guessed
  // pixel value, which drifts across browsers/zoom levels/font metrics
  // (that guessing is what caused the gap-vs-overlap bugs before this).
  // Measured via ResizeObserver instead, and only applied above the mobile
  // breakpoint — on mobile the list is a bottom sheet, unrelated to the
  // row's position, so no inline top should be forced there.
  const [sidePanelTop, setSidePanelTop] = useState<number | null>(null);
  // Mobile-web collapsible bottom sheet — desktop's .list-panel-outer stays
  // fully positioned by CSS (sidePanelTop above), this only ever drives
  // mobile's version. mapFrameRef/frameHeight measure the sheet's actual
  // container so the three snap states are real pixel heights, not a bare
  // CSS percentage that can't be dragged smoothly. dragHeightRef mirrors
  // dragHeight but read synchronously inside the pointer-move handler,
  // which fires faster than React re-renders can keep the state read
  // fresh — using stale state there produced visible jitter.
  const mapFrameRef = useRef<HTMLDivElement>(null);
  const [frameHeight, setFrameHeight] = useState(0);
  const [sheetState, setSheetState] = useState<SheetState>('collapsed');
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const dragHeightRef = useRef<number | null>(null);
  const [isDraggingSheet, setIsDraggingSheet] = useState(false);
  const dragStartRef = useRef<{ startY: number; startHeight: number; lastY: number; lastT: number; velocity: number } | null>(null);
  // Selecting a result sets `query` to the place name to show it in the box —
  // that alone would re-trigger the debounced autocomplete effect below and
  // pop the dropdown back open a moment later. This flag tells that effect
  // to skip the one refetch caused by a selection (not by actual typing).
  const skipNextSearchRef = useRef(false);
  const [flyToCenter, setFlyToCenter] = useState<{ center: [number, number]; token: number } | null>(null);
  // A pinned point that isn't one of our own listings — set either by a
  // landmark search selection or a raw click on empty map. Drives both the
  // map's pin marker AND the "+ Add this place" button: however the point
  // got pinned, that button adds a listing there. Cleared when a real
  // listing is selected instead, or the search box is cleared.
  const [searchPin, setSearchPin] = useState<{ lat: number; lng: number } | null>(null);
  // True while the Add Listing modal is hidden and the user is picking a
  // location directly on this full-screen map instead (see
  // startPickingLocation/cancelPickingLocation/confirmAddThisPlace below).
  const [pickingLocation, setPickingLocation] = useState(false);
  // The confirmed result of a pick, handed to AddListingModal via its
  // `pickedLocation` prop. Token-keyed (not just lat/lon) so picking the
  // same spot twice in a row still counts as a fresh confirmation.
  const [pickedLocation, setPickedLocation] = useState<{ lat: number; lon: number; token: number } | null>(null);
  // Which action started picking mode — changes the explanatory dialogue's
  // copy below (a plain "tap the map" prompt vs. explicitly asking the
  // user to confirm their GPS fix before it's applied).
  const [pickingSource, setPickingSource] = useState<'manual' | 'current-location'>('manual');
  // The explanatory dialogue is an acknowledgment step, not the actual
  // confirmation (that's still "Use this spot"/"Cancel") — dismissing it
  // just hides the card; reset to false every time picking starts so it
  // reliably reappears on the next pick rather than staying dismissed.
  const [pickingDialogDismissed, setPickingDialogDismissed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await supabase.from('listings').select('*, votes(count)').order('price_rupees', { ascending: true });
    if (error || !data) {
      setLoadError("Couldn't load listings. Check your connection and try again.");
      setLoading(false);
      return;
    }
    setListings(data.map((row: any) => ({ ...row, voteCount: row.votes?.[0]?.count ?? 0 })));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Memoized so this array's identity only changes when listings or the
  // query actually change — MapView re-fits the camera to it whenever the
  // reference changes, so a stable reference across unrelated re-renders
  // (e.g. the results-dropdown open/close state) stops that refit from
  // firing and stomping on an in-progress flyToCenter animation. Declared
  // before the search effect below, which reads filtered.length to decide
  // whether an external search is even needed.
  const filtered = useMemo(
    () => listings.filter((l) => l.name.toLowerCase().includes(query.toLowerCase())),
    [listings, query]
  );

  // Landmark search on the browse map — separate from the substring filter
  // above (runs on every keystroke, no debounce, purely local): this
  // debounces a call out to OLA Places so searching a landmark (not
  // necessarily a listed spot) can fly the map there. Skipped entirely when
  // the query already matches an existing listing (filtered.length > 0) —
  // the local list/map already show that match, so there's no need to also
  // hit the external API, which keeps ordinary filter-typing from firing
  // unnecessary network requests.
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false;
      return;
    }
    if (!query.trim()) {
      setPlaceResults([]);
      setSearchPin(null);
      return;
    }
    if (filtered.length > 0) {
      setPlaceResults([]);
      setSearchResultsOpen(false);
      return;
    }
    searchDebounce.current = setTimeout(async () => {
      const results = await searchPlaces(query);
      setPlaceResults(results);
      setSearchResultsOpen(true);
    }, 400);
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, [query, filtered.length]);

  // Close the results dropdown on an outside click — it should only go away
  // by picking a result or clearing the search, not stay open forever.
  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (searchInputRef.current?.contains(e.target as Node)) return;
      if (searchResultsRef.current?.contains(e.target as Node)) return;
      setSearchResultsOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  // ListingDetailModal now renders as a plain block above .list-panel (see
  // .list-panel-outer in styles.css) rather than scrolling with it, so it
  // can't be scrolled behind/under — but reset .list-panel's own scroll on
  // selection anyway so the *card list* also starts from its top instead
  // of wherever it was left scrolled.
  useEffect(() => {
    if (selectedListingId) {
      listPanelRef.current?.scrollTo({ top: 0 });
    }
  }, [selectedListingId]);

  // FLIP animation: the clicked list-card visibly "flies" from where it
  // was in the list up into the detail-card slot at the top, instead of
  // the detail card just appearing there — otherwise it isn't obvious that
  // the card the user tapped is the one that moved. Runs before paint
  // (useLayoutEffect) so the starting offset is applied before the browser
  // ever shows the card at its final position.
  useLayoutEffect(() => {
    const fromTop = flyFromTopRef.current;
    flyFromTopRef.current = null;
    if (fromTop == null || !selectedListingId) return;
    const el = coverRef.current;
    if (!el) return;

    const deltaY = fromTop - el.getBoundingClientRect().top;
    if (Math.abs(deltaY) < 1) return;

    el.style.transition = 'none';
    el.style.transform = `translateY(${deltaY}px)`;
    // Force layout so the browser commits the starting position above
    // before the transition below is allowed to animate from it.
    el.getBoundingClientRect();
    requestAnimationFrame(() => {
      el.style.transition = 'transform 0.3s ease';
      el.style.transform = 'translateY(0)';
    });
    const cleanup = setTimeout(() => {
      el.style.transition = '';
      el.style.transform = '';
    }, 350);
    return () => clearTimeout(cleanup);
  }, [selectedListingId]);

  // Keeps .list-panel-outer's top edge glued to the overlay row's actual
  // rendered bottom edge — recomputed on resize/wrap (the row can go from
  // one line to two on narrow desktop widths, or the Contribute/Cancel
  // swap can change its width) rather than assumed from a fixed height.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MEDIA_QUERY);
    function measure() {
      if (mq.matches) {
        setSidePanelTop(null);
        return;
      }
      const row = overlayRowRef.current;
      if (row) setSidePanelTop(row.offsetTop + row.offsetHeight);
    }
    measure();
    const resizeObserver = new ResizeObserver(measure);
    if (overlayRowRef.current) resizeObserver.observe(overlayRowRef.current);
    mq.addEventListener('change', measure);
    window.addEventListener('resize', measure);
    return () => {
      resizeObserver.disconnect();
      mq.removeEventListener('change', measure);
      window.removeEventListener('resize', measure);
    };
  }, [pickingLocation]);

  // Measures .map-frame's real rendered height so the bottom sheet's three
  // snap states (computeSheetSnaps) are actual pixel heights the drag
  // handlers below can track 1:1 with the finger — a bare CSS percentage
  // can't be read/interpolated from JS during a drag. Runs regardless of
  // viewport (cheap, harmless on desktop — nothing there consumes
  // frameHeight/--sheet-h).
  useEffect(() => {
    const el = mapFrameRef.current;
    if (!el) return;
    const resizeObserver = new ResizeObserver(([entry]) => {
      setFrameHeight(entry.contentRect.height);
    });
    resizeObserver.observe(el);
    setFrameHeight(el.clientHeight);
    return () => resizeObserver.disconnect();
  }, []);

  const sheetSnaps = useMemo(() => computeSheetSnaps(frameHeight), [frameHeight]);
  // While dragging, the finger's raw offset wins; otherwise the current
  // snap state's own height applies (animated via CSS transition — see
  // .list-panel-outer's `dragging` class toggle below, which turns that
  // transition off only while a drag is actually in progress).
  const appliedSheetHeight = dragHeight ?? sheetSnaps[sheetState];

  function handleSheetDragStart(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startHeight = dragHeightRef.current ?? sheetSnaps[sheetState];
    dragStartRef.current = { startY: e.clientY, startHeight, lastY: e.clientY, lastT: performance.now(), velocity: 0 };
    setIsDraggingSheet(true);
  }

  function handleSheetDragMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragStartRef.current;
    if (!drag) return;
    // Moving the finger UP (smaller clientY) should make the sheet taller.
    const deltaY = drag.startY - e.clientY;
    const minHeight = sheetSnaps.collapsed * 0.7;
    const maxHeight = sheetSnaps.expanded * 1.04;
    const nextHeight = Math.max(minHeight, Math.min(maxHeight, drag.startHeight + deltaY));
    dragHeightRef.current = nextHeight;
    setDragHeight(nextHeight);

    const now = performance.now();
    const dt = now - drag.lastT;
    if (dt > 0) drag.velocity = (drag.lastY - e.clientY) / dt; // px/ms, positive = moving up
    drag.lastY = e.clientY;
    drag.lastT = now;
  }

  // Nearest-snap-point on release, unless the finger was moving fast enough
  // to read as a deliberate flick — then it jumps one state further in
  // that direction even if the released height is still closer to the
  // state it started from, which is what makes a quick swipe feel
  // responsive rather than needing to travel the full distance by hand.
  function handleSheetDragEnd() {
    const drag = dragStartRef.current;
    if (!drag) return;
    dragStartRef.current = null;
    setIsDraggingSheet(false);

    const releasedHeight = dragHeightRef.current ?? drag.startHeight;
    dragHeightRef.current = null;
    setDragHeight(null);

    const order: SheetState[] = ['collapsed', 'partial', 'expanded'];
    const FLING_PX_PER_MS = 0.5;
    let next: SheetState;
    if (Math.abs(drag.velocity) > FLING_PX_PER_MS) {
      const currentIndex = order.indexOf(sheetState);
      const step = drag.velocity > 0 ? 1 : -1;
      next = order[Math.max(0, Math.min(order.length - 1, currentIndex + step))];
    } else {
      next = order.reduce((closest, candidate) =>
        Math.abs(sheetSnaps[candidate] - releasedHeight) < Math.abs(sheetSnaps[closest] - releasedHeight) ? candidate : closest
      , 'collapsed' as SheetState);
    }
    setSheetState(next);
  }

  // OLA's autocomplete already returns coordinates inline, no follow-up
  // details fetch needed before flying the camera there. Reuses the exact
  // same flyToCenter mechanism as selectListing and startPickingLocation
  // below, so all three share identical camera behavior.
  function selectSearchResult(place: PlaceSuggestion) {
    skipNextSearchRef.current = true;
    setQuery(place.name);
    setPlaceResults([]);
    setSearchResultsOpen(false);
    setSearchPin({ lat: place.latitude, lng: place.longitude });
    setFlyToCenter((prev) => ({ center: [place.longitude, place.latitude], token: (prev?.token ?? 0) + 1 }));
  }

  // Fires the debounced landmark search immediately — for the search bar's
  // clickable search icon, so it doesn't just sit there decoratively.
  function runSearchNow() {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!query.trim() || filtered.length > 0) return;
    searchPlaces(query).then((results) => {
      setPlaceResults(results);
      setSearchResultsOpen(true);
    });
  }

  // Selecting a listing (map marker or list card) shares the exact same
  // camera mechanism as a landmark search — same pan+zoom, same reliability
  // — instead of relying solely on the info-window effect's own panTo.
  // Opens the full ListingDetailModal pinned at the top of the panel on
  // every viewport (mobile included) — .list-panel below already excludes
  // whichever listing is selected, so there's no duplicate card.
  function selectListing(id: string) {
    setSelectedListingId(id);
    setSearchPin(null);
    // Mobile's bottom sheet defaults to collapsed (~1 card peeking above
    // the map) — a fresh selection needs at least the "partial" state to
    // actually show its detail card, otherwise it'd open pinned at the top
    // of a sheet too short to display it. Only bumps up, never collapses
    // a sheet the user already had further open. No-op on desktop, which
    // doesn't read sheetState for anything.
    setSheetState((prev) => (prev === 'collapsed' ? 'partial' : prev));
    const listing = listings.find((l) => l.id === id);
    if (listing) {
      setFlyToCenter((prev) => ({ center: [listing.longitude, listing.latitude], token: (prev?.token ?? 0) + 1 }));
    }
  }

  function handlePosted() {
    setShowAdd(false);
    setAddInitialCoords(undefined);
    setPickedLocation(null);
    setPickingLocation(false);
    setPickingDialogDismissed(false);
    setSearchPin(null);
    load();
  }

  // Clicking empty map no longer opens Add Listing instantly — it drops a
  // pin and swaps the hint pill into a dedicated "+ Add this place" button,
  // so a stray/misplaced tap doesn't immediately launch the form.
  function handleMapClick(latitude: number, longitude: number) {
    setSearchPin({ lat: latitude, lng: longitude });
  }

  // "Pick on map" inside an already-open Add Listing modal hides that modal
  // (its own draft state stays untouched) and hands off to this same
  // full-screen map — seeding a candidate pin at the modal's current
  // location, if it had one, so refining an existing pick starts from
  // there instead of a blank map. `source` just picks which copy the
  // explanatory dialogue below shows.
  function startPickingLocation(current: { lat: number; lon: number } | null, source: 'manual' | 'current-location' = 'manual') {
    setPickingLocation(true);
    setPickingSource(source);
    setPickingDialogDismissed(false);
    if (current) {
      setSearchPin({ lat: current.lat, lng: current.lon });
      setFlyToCenter((prev) => ({ center: [current.lon, current.lat], token: (prev?.token ?? 0) + 1 }));
    } else {
      setSearchPin(null);
    }
  }

  function cancelPickingLocation() {
    setPickingLocation(false);
    setPickingDialogDismissed(false);
    setSearchPin(null);
  }

  // Works no matter how the point got pinned — a raw map click, a landmark
  // search selection, or search-on-map — since both funnel into searchPin.
  // While picking for an already-open modal, the result goes back into that
  // modal instead of opening a brand-new one.
  function confirmAddThisPlace() {
    if (!searchPin) return;
    if (pickingLocation) {
      setPickedLocation((prev) => ({ lat: searchPin.lat, lon: searchPin.lng, token: (prev?.token ?? 0) + 1 }));
      setPickingLocation(false);
      setPickingDialogDismissed(false);
      setSearchPin(null);
      return;
    }
    setAddInitialCoords({ lat: searchPin.lat, lon: searchPin.lng });
    setShowAdd(true);
    setSearchPin(null);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand">
            <Logo size={26} />
            <span>Beggars Map</span>
          </div>
          <div className="brand-sub">Cheap eats in Bengaluru, ₹100 or under</div>
        </div>
        <button className="about-button" onClick={() => setShowAbout(true)}>About Us</button>
      </header>

      <div className="coming-soon-banner">Launching soon in all other major cities</div>

      <main className="main">
        <section className="about-panel">
          <AboutContent />
        </section>

        <div className="map-panel">
          <div
            className="map-frame"
            ref={mapFrameRef}
            style={frameHeight > 0 ? ({ '--sheet-h': `${appliedSheetHeight}px` } as CSSProperties) : undefined}
          >
            <MapView
              listings={filtered}
              onSelectListing={pickingLocation ? () => {} : selectListing}
              showLocate
              onMapClick={handleMapClick}
              flyToCenter={flyToCenter ?? undefined}
              searchPin={searchPin}
              selectedListingId={pickingLocation ? null : selectedListingId}
            />

            <div className="map-overlay-row" ref={overlayRowRef}>
              <div className="search-bar">
                <select className="city-select-inline" value="Bengaluru" onChange={() => {}} aria-label="City">
                  {CITIES.map((city) => (
                    <option key={city} value={city} disabled={city !== 'Bengaluru'}>
                      {city === 'Bengaluru' ? city : `${city} (soon)`}
                    </option>
                  ))}
                </select>
                <span className="search-bar-divider" aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  className="search-input-inline"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onFocus={() => setSearchResultsOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') runSearchNow();
                  }}
                  placeholder="Search by landmark or restaurant name"
                />
                <button className="search-icon-button" onClick={runSearchNow} aria-label="Search">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.2" y2="16.2" />
                  </svg>
                </button>
              </div>
              {pickingLocation ? (
                <button className="secondary-button map-picking-cancel picking-fade-in" onClick={cancelPickingLocation}>Cancel</button>
              ) : (
                <button className="primary-button contribute-button" onClick={() => setShowAdd(true)}>+ Contribute</button>
              )}
            </div>

            {pickingLocation && !pickingDialogDismissed ? (
              <div className="picking-dialog picking-fade-in">
                {pickingSource === 'current-location' ? (
                  <>
                    <p className="picking-dialog-title">Is this your current location?</p>
                    <p className="picking-dialog-body">Tap the map to adjust it, or confirm below.</p>
                  </>
                ) : (
                  <p className="picking-dialog-title">Tap the map, or search a location/landmark, to choose this listing's location.</p>
                )}
                <button className="primary-button" onClick={() => setPickingDialogDismissed(true)}>OK</button>
              </div>
            ) : null}

            {searchResultsOpen && placeResults.length > 0 ? (
              <div className="map-search-results" ref={searchResultsRef}>
                {placeResults.map((p) => (
                  <div key={p.placeId} className="result-row" onClick={() => selectSearchResult(p)}>
                    <div className="result-name">{p.name}</div>
                    {p.address ? <div className="result-address">{p.address}</div> : null}
                  </div>
                ))}
              </div>
            ) : searchPin ? (
              <div
                className={`map-click-hint map-click-hint-action${pickingLocation ? ' picking-fade-in' : ''}`}
                onClick={confirmAddThisPlace}
              >
                + Add this place
              </div>
            ) : (
              <div className="map-click-hint">
                {pickingLocation ? 'Click the map, or search a landmark, to place your pin' : 'Click the map to add a spot'}
              </div>
            )}

            <div
              className={`list-panel-outer${isDraggingSheet ? ' sheet-dragging' : ''}`}
              style={sidePanelTop != null ? { top: sidePanelTop } : undefined}
            >
              <div
                className="sheet-drag-handle"
                onPointerDown={handleSheetDragStart}
                onPointerMove={handleSheetDragMove}
                onPointerUp={handleSheetDragEnd}
                onPointerCancel={handleSheetDragEnd}
                role="button"
                tabIndex={-1}
                aria-label="Drag to resize the restaurant list"
              >
                <span className="sheet-drag-handle-bar" aria-hidden="true" />
              </div>

              {selectedListingId ? (
                <ListingDetailModal ref={coverRef} listingId={selectedListingId} onClose={() => setSelectedListingId(null)} onUpdated={load} />
              ) : null}

              <aside className="list-panel" ref={listPanelRef}>
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
                  listings.length === 0 ? (
                    <p className="loading-text">No listings yet. Be the first to add one.</p>
                  ) : !pickingLocation ? (
                    <p className="loading-text">
                      No listings match your search, want to{' '}
                      <button className="text-button-inline" onClick={() => setShowAdd(true)}>
                        add it to the map
                      </button>
                      ?
                    </p>
                  ) : null
                ) : null}

                {filtered
                  .filter((listing) => listing.id !== selectedListingId)
                  .map((listing) => (
                    <div
                      key={listing.id}
                      className="list-card"
                      onClick={(e) => {
                        flyFromTopRef.current = e.currentTarget.getBoundingClientRect().top;
                        selectListing(listing.id);
                      }}
                    >
                      <div className="list-card-header">
                        <span className="list-card-name">{listing.name}</span>
                        <span className="list-card-price">₹{listing.price_rupees}</span>
                      </div>
                      {listing.note ? <p className="list-card-note">{listing.note}</p> : null}
                      <div className="list-card-footer">
                        <span className="list-card-votes">▲ {listing.voteCount}</span>
                        <span className="list-card-posted">{formatRelativeTime(listing.created_at)}</span>
                      </div>
                    </div>
                  ))}
              </aside>
            </div>
          </div>
        </div>
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
            setPickedLocation(null);
            setPickingLocation(false);
            setPickingDialogDismissed(false);
            setSearchPin(null);
          }}
          onPosted={handlePosted}
          initialCoords={addInitialCoords}
          onPickOnMap={startPickingLocation}
          pickedLocation={pickedLocation}
          hidden={pickingLocation}
        />
      ) : null}
      {legalTab ? <LegalModal initialTab={legalTab} onClose={() => setLegalTab(null)} /> : null}
      {showAbout ? <AboutModal onClose={() => setShowAbout(false)} /> : null}
    </div>
  );
}
