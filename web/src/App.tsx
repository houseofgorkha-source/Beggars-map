import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { supabase } from './lib/supabase';
import { searchPlaces, type PlaceSuggestion } from './lib/olaPlaces';
import { formatRelativeTime } from './lib/relativeTime';
import { distanceKm } from './lib/distance';
import MapView from './components/MapView';
import Logo from './components/Logo';
import AddListingModal from './components/AddListingModal';
import LegalModal from './components/LegalModal';
import AboutContent from './components/AboutContent';
import AboutModal from './components/AboutModal';
import type { Listing } from './types';

type ListingWithVotes = Listing & { voteCount: number };
// Mirrors native mobile's own ListingWithDistance (src/screens/MapScreen.tsx)
// — distance is computed client-side from the user's own location, so it's
// a derived layer on top of the fetched listings rather than part of what
// `load()` fetches.
type ListingWithDistance = ListingWithVotes & { distanceKm: number | null };

const CITIES = ['Bengaluru', 'Delhi', 'Mumbai', 'Kolkata', 'Chennai', 'Guwahati'];

// Portrait phones only — landscape phones/tablets deliberately use the
// desktop-style side panel instead of the MAP/LIST bottom sheet (see the
// "LANDSCAPE phones/tablets" block in styles.css), so this must stay
// narrower than a bare max-width check. Mirrors styles.css's own
// `@media (max-width: 720px) and (orientation: portrait)` block — kept as
// one shared string so the CSS and JS "is this the sheet experience?"
// answers can't drift apart.
const MOBILE_PORTRAIT_QUERY = '(max-width: 720px) and (orientation: portrait)';

// Two independent interaction modes, not a continuum: MAP mode (default —
// the map fills the screen, the sheet is shrunk to just its drag handle plus
// a hint pill) and LIST mode (the sheet takes over as the primary surface,
// map "gets out of the way"). Selecting a listing always shows its details
// via MapView's own map-anchored popup, never inside the sheet — so
// selection doesn't add anything to what the sheet itself has to display,
// it just forces MAP mode if LIST mode was open (see selectListing) so that
// popup is actually visible. There is deliberately no third "partial" state
// — that in-between size was what let the map and list fight over the same
// screen in the old design.
type SheetState = 'map' | 'list';

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = () => setMatches(mq.matches);
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

// The MAP-mode snap height is derived from the actual measured height of
// the sheet's "peek zone" (drag handle + hint pill — a constant, since
// selection no longer adds anything here) — not a guessed constant — so the
// sheet is always sized to exactly fit whatever's peeking above it, with
// zero list content showing through. LIST mode stays a generous fraction of the
// frame, same idea as before, just without the old "partial" middle step —
// but capped by `containerHeight - TOP_RESERVE_PX` as a hard ceiling, not
// just a fraction of the frame. Without that hard cap, a short (landscape)
// frame could compute a LIST height tall enough that the sheet's own top
// edge — where the drag handle lives — ends up underneath the floating
// search/Contribute row pinned near the frame's actual top edge. That row
// sits at a higher z-index, so it silently swallows the drag handle's
// pointer events, making the sheet impossible to drag back down.
const TOP_RESERVE_PX = 70;
function computeSheetSnaps(containerHeight: number, peekContentHeight: number) {
  const map = Math.round(Math.max(48, Math.min(containerHeight * 0.6, peekContentHeight)));
  const list = Math.round(Math.max(map + 24, Math.min(containerHeight * 0.86, containerHeight - TOP_RESERVE_PX)));
  return { map, list };
}

export default function App() {
  const isMobilePortrait = useMediaQuery(MOBILE_PORTRAIT_QUERY);
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
  // Scroll container for the list rows — used to bring the selected row
  // into view when selection comes from a map-pin click (desktop/tablet/
  // landscape only; mobile portrait collapses the sheet on selection
  // instead, so the list isn't even visible at that moment).
  const listPanelRef = useRef<HTMLDivElement>(null);
  const overlayRowRef = useRef<HTMLDivElement>(null);
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
  // The list panel's own outer container — measured (not CSS-math-guessed,
  // same philosophy as frameHeight/sidePanelTop above) so MapView's popup can
  // clamp itself to never render underneath it. Only meaningful on
  // desktop/tablet/landscape, where the list floats as a side panel over the
  // map; on mobile portrait it becomes a full-width bottom sheet instead, so
  // there's no horizontal boundary to keep the popup clear of there — see
  // rightInset below.
  const listPanelOuterRef = useRef<HTMLDivElement>(null);
  const [rightInset, setRightInset] = useState(0);
  const [sheetState, setSheetState] = useState<SheetState>('map');
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
  // Mirrors native mobile's own auto-request-on-mount pattern (MapScreen.tsx):
  // best-effort, silent — a denied/unavailable permission just leaves this
  // null forever and every listing's distanceKm stays null too (nothing
  // shown), same as native's own graceful fallback. Independent of the
  // "Locate me" button on the map itself (MapView.tsx's own locateMe), which
  // recenters the camera and isn't touched by this.
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => {}
    );
  }, []);

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

  // Distance is a derived layer on top of the fetched listings — recomputed
  // whenever either the listings or the user's own location changes, not
  // baked into `load()` itself (userLocation usually resolves asynchronously
  // after the first load already happened).
  const listingsWithDistance: ListingWithDistance[] = useMemo(
    () =>
      listings.map((l) => ({
        ...l,
        distanceKm: userLocation ? distanceKm(userLocation.lat, userLocation.lon, l.latitude, l.longitude) : null,
      })),
    [listings, userLocation]
  );

  // Memoized so this array's identity only changes when listings or the
  // query actually change — MapView re-fits the camera to it whenever the
  // reference changes, so a stable reference across unrelated re-renders
  // (e.g. the results-dropdown open/close state) stops that refit from
  // firing and stomping on an in-progress flyToCenter animation. Declared
  // before the search effect below, which reads filtered.length to decide
  // whether an external search is even needed.
  const filtered = useMemo(
    () => listingsWithDistance.filter((l) => l.name.toLowerCase().includes(query.toLowerCase())),
    [listingsWithDistance, query]
  );

  // Mobile-only list ordering — nearest-first when the viewer's own location
  // is known, else newest-first. Desktop/tablet/landscape keep `filtered`'s
  // own order (cheapest-first, from the Supabase query) unchanged. Doesn't
  // touch pin order on the map (MapView is still fed `filtered` directly) —
  // order is irrelevant there, only the scrollable list cares.
  const mobileListListings = useMemo(() => {
    if (!isMobilePortrait) return filtered;
    const sorted = [...filtered];
    if (userLocation) {
      sorted.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    } else {
      sorted.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    }
    return sorted;
  }, [filtered, isMobilePortrait, userLocation]);

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

  // Brings the selected listing's row into view when it might be scrolled
  // off-screen — desktop/tablet/landscape only, where the list stays
  // visible beside the map at all times. Mobile portrait collapses the
  // sheet on selection instead (see selectListing below), so the list
  // isn't even visible at the moment of selection there. `block: 'nearest'`
  // (no smooth scroll) so this can't fight a user's own in-progress scroll.
  useEffect(() => {
    if (isMobilePortrait || !selectedListingId) return;
    const row = listPanelRef.current?.querySelector<HTMLElement>(`[data-listing-id="${selectedListingId}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedListingId, isMobilePortrait]);

  // Keeps .list-panel-outer's top edge glued to the overlay row's actual
  // rendered bottom edge — recomputed on resize/wrap (the row can go from
  // one line to two on narrow desktop widths, or the Add/Cancel swap can
  // change its width) rather than assumed from a fixed height. Only
  // portrait phones skip this (their sheet is bottom-anchored, unrelated to
  // the row's position) — landscape phones now use the same measured
  // side-panel positioning as desktop/tablet, same as this effect already
  // provides.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_PORTRAIT_QUERY);
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

  // Pixels reserved on the right of the map that the popup must not render
  // underneath — the list panel's own real rendered width (measured, not
  // computed from its clamp()/fixed-width CSS, so it can never drift out of
  // sync with what actually renders), zero on mobile portrait where the list
  // is a bottom sheet rather than a right-side panel. Mirrors bottomInset's
  // existing approach (also measured, also zeroed out on the one breakpoint
  // where the thing it protects against isn't present) rather than
  // introducing a second, differently-shaped mechanism for the same job.
  useEffect(() => {
    if (isMobilePortrait) {
      setRightInset(0);
      return;
    }
    const frame = mapFrameRef.current;
    const panel = listPanelOuterRef.current;
    if (!frame || !panel) return;
    function measure() {
      if (!frame || !panel) return;
      setRightInset(Math.max(0, frame.getBoundingClientRect().right - panel.getBoundingClientRect().left));
    }
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(frame);
    resizeObserver.observe(panel);
    window.addEventListener('resize', measure);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [isMobilePortrait]);

  // Measures `.sheet-peek-zone` — the drag handle plus, on mobile, the hint
  // pill — so MAP mode's sheet height is always exactly "whatever's peeking
  // above the map", never a guessed pixel value. This content is now
  // constant regardless of selection (selection shows its details via
  // MapView's own popup instead), so this measurement no longer varies
  // between a listing being selected or not.
  const sheetPeekRef = useRef<HTMLDivElement>(null);
  const [peekHeight, setPeekHeight] = useState(0);
  useEffect(() => {
    const el = sheetPeekRef.current;
    if (!el) return;
    const resizeObserver = new ResizeObserver(([entry]) => {
      setPeekHeight(entry.contentRect.height);
    });
    resizeObserver.observe(el);
    setPeekHeight(el.getBoundingClientRect().height);
    return () => resizeObserver.disconnect();
  }, []);

  const sheetSnaps = useMemo(() => computeSheetSnaps(frameHeight, peekHeight), [frameHeight, peekHeight]);
  // While dragging, the finger's raw offset wins; otherwise the current
  // snap state's own height applies (animated via CSS transition — see
  // .list-panel-outer's `dragging` class toggle below, which turns that
  // transition off only while a drag is actually in progress).
  const appliedSheetHeight = dragHeight ?? sheetSnaps[sheetState];

  // Closes any open popup the moment the user manually expands to LIST mode
  // (by dragging the handle or tapping the "swipe up" hint — both just set
  // sheetState, so one effect here covers every entry path). MapView's
  // popup sits at a higher z-index than the sheet so it can float above the
  // map (`.map-popup-anchor`, z-index 10, vs. `.list-panel-outer`, z-index
  // 4) — without this, a popup left open while switching to LIST mode would
  // keep floating at its last pin-anchored position on top of the now-
  // expanded list, visually and functionally covering part of it (including
  // the drag handle itself). Matches the existing convention that the map's
  // own controls (zoom/locate/click-hint) already hide themselves once LIST
  // mode makes the map "not the active surface" — the popup is a map
  // control in the same sense. selectListing's own forced MAP-mode
  // collapse (which runs in the same tick as setting the selection) means
  // this never fights a fresh selection — sheetState is already back to
  // 'map' by the time this effect would otherwise see 'list'.
  useEffect(() => {
    if (isMobilePortrait && sheetState === 'list') {
      setSelectedListingId(null);
    }
  }, [sheetState, isMobilePortrait]);

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
    const minHeight = sheetSnaps.map * 0.85;
    const maxHeight = sheetSnaps.list * 1.04;
    const nextHeight = Math.max(minHeight, Math.min(maxHeight, drag.startHeight + deltaY));
    dragHeightRef.current = nextHeight;
    setDragHeight(nextHeight);

    const now = performance.now();
    const dt = now - drag.lastT;
    if (dt > 0) drag.velocity = (drag.lastY - e.clientY) / dt; // px/ms, positive = moving up
    drag.lastY = e.clientY;
    drag.lastT = now;
  }

  // Snaps to whichever of the two modes is closer on release, unless the
  // finger was moving fast enough to read as a deliberate flick — then it
  // always jumps to the mode in that direction even if the released height
  // is technically still closer to the mode it started from, which is what
  // makes a quick swipe feel responsive rather than needing to travel the
  // full distance by hand.
  function handleSheetDragEnd() {
    const drag = dragStartRef.current;
    if (!drag) return;
    dragStartRef.current = null;
    setIsDraggingSheet(false);

    const releasedHeight = dragHeightRef.current ?? drag.startHeight;
    dragHeightRef.current = null;
    setDragHeight(null);

    const FLING_PX_PER_MS = 0.5;
    let next: SheetState;
    if (Math.abs(drag.velocity) > FLING_PX_PER_MS) {
      next = drag.velocity > 0 ? 'list' : 'map';
    } else {
      const midpoint = (sheetSnaps.map + sheetSnaps.list) / 2;
      next = releasedHeight > midpoint ? 'list' : 'map';
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
  // Opens the same map-anchored popup (MapView's own, see `hidePopup` below)
  // on every viewport, mobile included — a map-pin tap and a list-row tap
  // now always converge on the exact same "full info" surface.
  //
  // On mobile portrait, also forces the sheet back to MAP mode: if a list
  // tap happened while the sheet was expanded (LIST mode covers most of the
  // frame), the popup would otherwise render hidden behind it. This is what
  // makes "tapping a list row opens the same info as tapping a pin" actually
  // true in practice, not just in theory.
  function selectListing(id: string) {
    setSelectedListingId(id);
    setSearchPin(null);
    if (isMobilePortrait) setSheetState('map');
    const listing = listings.find((l) => l.id === id);
    if (listing) {
      setFlyToCenter((prev) => ({ center: [listing.longitude, listing.latitude], token: (prev?.token ?? 0) + 1 }));
    }
  }

  // The single source of truth for "close every internal view and return to
  // the plain browsing map" — used by every close/cancel action (Add
  // Listing's own ✕, the Legal/About modals, deselecting a listing) AND by
  // the browser-back handler below, so there is exactly one definition of
  // what "home" means and every path back to it behaves identically. Only
  // ever built from useState setters (all stable references), so it's safe
  // to close over from an effect with an empty dependency array below.
  const resetToHome = useCallback(() => {
    setShowAdd(false);
    setAddInitialCoords(undefined);
    setPickedLocation(null);
    setPickingLocation(false);
    setPickingDialogDismissed(false);
    setSearchPin(null);
    setLegalTab(null);
    setShowAbout(false);
    setSelectedListingId(null);
  }, []);

  // Whether the app is currently showing anything other than the plain
  // browsing map — every one of these is a distinct "internal view" a
  // browser back-press or edge-swipe should close rather than exiting the
  // site. Deliberately excludes lighter-weight, transient UI (the search
  // results dropdown, a report popover) — those aren't "views" a user would
  // expect a back-press to navigate out of.
  const hasOpenState = showAdd || legalTab !== null || showAbout || selectedListingId !== null;

  // Keeps one browser-history entry in sync with hasOpenState so back/
  // side-swipe closes an internal view instead of leaving the site — this
  // app has no router and never touched the History API before, so by
  // default *every* back-press just left beggarsmap.com entirely, including
  // from mid-flow (Add Listing open, a listing selected, etc.).
  //
  // The approach: push exactly one entry the moment something opens (the
  // false -> true transition of hasOpenState, not one push per nested
  // change — opening Legal while Add is already open doesn't push a
  // second entry). Closing that state through the UI (an X button, Cancel,
  // successful submit) consumes that same entry via history.back() so the
  // stack never grows unboundedly. Actually pressing back/side-swiping
  // fires `popstate`, which isPoppingRef distinguishes from a UI-triggered
  // close so the sync effect below doesn't call history.back() a second
  // time in response to the browser's own navigation — that double-call was
  // the exact bug being fixed: it would consume the pushed entry via the
  // popstate-driven reset, then this effect's own (redundant) history.back()
  // would consume one entry *too many*, landing on whatever real page was
  // open before this site — i.e. still exiting it, just one press later.
  const isPoppingRef = useRef(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    function handlePopState() {
      isPoppingRef.current = true;
      resetToHome();
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [resetToHome]);

  useEffect(() => {
    if (hasOpenState && !wasOpenRef.current) {
      window.history.pushState({ beggarsMapOpen: true }, '');
    } else if (!hasOpenState && wasOpenRef.current) {
      if (isPoppingRef.current) {
        isPoppingRef.current = false;
      } else if (window.history.state?.beggarsMapOpen) {
        window.history.back();
      }
    }
    wasOpenRef.current = hasOpenState;
  }, [hasOpenState]);

  function handlePosted() {
    resetToHome();
    load();
  }

  // A plain map click is browsing, not adding — it must never drop a
  // candidate pin or surface "+ Add this place" on its own. Placing a pin
  // by tapping the map is only meaningful once the user has explicitly
  // entered the picking sub-flow (via AddListingModal's "Pick on map" /
  // "Use current location", which is what sets pickingLocation), so a raw
  // click outside that flow is a no-op here and Google's own default map
  // interaction (pan handled natively, click otherwise ignored) is all
  // that happens.
  function handleMapClick(latitude: number, longitude: number) {
    if (!pickingLocation) return;
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
    // Picking a location fundamentally needs the map visible and tappable —
    // force MAP mode so LIST mode (where the map is mostly hidden) can't be
    // left open underneath this flow.
    setSheetState('map');
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

      <main className="main">
        <section className="about-panel">
          <AboutContent />
        </section>

        <div className="map-panel">
          <div
            className={`map-frame${isMobilePortrait && sheetState === 'list' && !pickingLocation ? ' list-mode-active' : ''}`}
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
              onClosePopup={resetToHome}
              onListingUpdated={load}
              hidePopup={pickingLocation}
              selectedDistanceKm={
                isMobilePortrait ? listingsWithDistance.find((l) => l.id === selectedListingId)?.distanceKm ?? null : null
              }
              bottomInset={isMobilePortrait ? appliedSheetHeight : 0}
              rightInset={rightInset}
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
                <button className="primary-button contribute-button" onClick={() => setShowAdd(true)}>+ Add</button>
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
            ) : pickingLocation ? (
              // Only ever shown mid-pick (see handleMapClick above) — outside
              // that explicit flow, clicking the map does nothing, so there
              // is nothing to hint at.
              <div className="map-click-hint">Click the map, or search a landmark, to place your pin</div>
            ) : null}

            <div
              ref={listPanelOuterRef}
              className={`list-panel-outer${isDraggingSheet ? ' sheet-dragging' : ''}`}
              style={sidePanelTop != null ? { top: sidePanelTop } : undefined}
            >
              <div className="sheet-peek-zone" ref={sheetPeekRef}>
                <div
                  className="sheet-drag-handle"
                  onPointerDown={handleSheetDragStart}
                  onPointerMove={handleSheetDragMove}
                  onPointerUp={handleSheetDragEnd}
                  onPointerCancel={handleSheetDragEnd}
                  role="button"
                  tabIndex={-1}
                  aria-label="Drag to switch between map and list view"
                >
                  <span className="sheet-drag-handle-bar" aria-hidden="true" />
                </div>

                {isMobilePortrait ? (
                  <button type="button" className="sheet-peek-hint" onClick={() => setSheetState('list')}>
                    Swipe up to browse restaurants <span aria-hidden="true">▲</span>
                  </button>
                ) : null}
              </div>

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

                {(isMobilePortrait ? mobileListListings : filtered).map((listing) => (
                  <div
                    key={listing.id}
                    data-listing-id={listing.id}
                    className={`list-card${listing.id === selectedListingId ? ' list-card-selected' : ''}`}
                    onClick={() => selectListing(listing.id)}
                  >
                    <div className="list-card-header">
                      <span className="list-card-name">{listing.name}</span>
                      <span className="list-card-price">₹{listing.price_rupees}</span>
                    </div>
                    {listing.note ? <p className="list-card-note">{listing.note}</p> : null}
                    <div className="list-card-footer">
                      <span className="list-card-meta">
                        <span className="list-card-votes">▲ {listing.voteCount}</span>
                        {listing.distanceKm != null ? (
                          <span className="list-card-distance">{listing.distanceKm.toFixed(1)} km away</span>
                        ) : null}
                      </span>
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
          onClose={resetToHome}
          onPosted={handlePosted}
          initialCoords={addInitialCoords}
          onPickOnMap={startPickingLocation}
          pickedLocation={pickedLocation}
          hidden={pickingLocation}
        />
      ) : null}
      {legalTab ? <LegalModal initialTab={legalTab} onClose={resetToHome} /> : null}
      {showAbout ? <AboutModal onClose={resetToHome} /> : null}
    </div>
  );
}
