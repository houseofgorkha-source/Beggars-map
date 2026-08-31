import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from 'react';
import { supabase } from './lib/supabase';
import { searchPlaces, bestPlaceMatch, type PlaceSuggestion } from './lib/olaPlaces';
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

// A query that doesn't match any listing by name/note is tried as an
// area/locality name instead (see the search effect below): OLA Places
// resolves it to a coordinate (reusing the same landmark-search call this
// app already makes, purely as a geocoder — its results are never shown to
// the user as selectable places in this path), and any of our own listings
// within this radius count as "in" that area. Bengaluru localities are
// typically a couple of km across, so this stays generous enough to catch
// a real match without pulling in listings from a clearly different area.
const AREA_MATCH_RADIUS_KM = 3;

// Bias for OLA's autocomplete/geocoding calls below — without this, OLA
// ranks purely by text relevance across all of India, so a cuisine/dish
// term ("biryani", "thali", "north indian") resolves to some same-named
// restaurant in a completely different city (confirmed live: "biryani"
// with no bias resolved to a Hyderabad restaurant, "thali" to one in
// Jaipur), which then finds zero nearby Beggars Map listings and falls
// through to showing that irrelevant out-of-city result. The app is
// Bengaluru-only today (see CITIES above), so this fixed center is a real,
// load-bearing fallback, not an invented location — it's superseded by the
// visitor's own location the moment that's available (see the search
// effect below).
const BENGALURU_CENTER = { lat: 12.9716, lon: 77.5946 };

// A fast, single-direction downward drag, measured the same way the sheet
// drag gesture measures its own pointer movement (distance + elapsed time)
// — see the home-exit touch handlers below.
const HOME_SWIPE_MIN_DISTANCE_PX = 70;
const HOME_SWIPE_MAX_DURATION_MS = 600;
const HOME_DOUBLE_SWIPE_WINDOW_MS = 900;

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
// it just forces MAP mode if LIST mode was open (see selectListingCore) so that
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
  // Populated by the search effect below only when the typed query matches
  // no listing by name/note/location_label — OLA resolves it as an
  // area/landmark instead (see AREA_MATCH_RADIUS_KM), and these are our own
  // nearby listings, not external places, so they flow into `filtered` the
  // same way a text match does. Local text matches always win outright when
  // any exist — this is a fallback, not a union (see textMatches/filtered).
  const [areaListings, setAreaListings] = useState<ListingWithDistance[]>([]);
  // The geocoded center behind `areaListings` (or null once there isn't
  // one) — kept separate from areaListings itself because it's needed for
  // two more things: ranking area matches nearest-to-that-point-first, and
  // flying the camera there even when zero listings ended up nearby (so an
  // area search still visibly moves the map to the searched place).
  const [areaCenter, setAreaCenter] = useState<{ lat: number; lon: number } | null>(null);
  // Drives MapView's camera fit for an executed search (Enter, the search
  // icon, or picking a dropdown suggestion) — deliberately a separate
  // mechanism from flyToCenter (used by listing selection/location-picking)
  // so this can't interfere with the popup/pin-anchoring architecture at
  // all. One or many points: one point pans+zooms there, several fit the
  // camera to bounds containing all of them.
  const [searchFocus, setSearchFocus] = useState<{ points: { lat: number; lng: number }[]; token: number } | null>(null);
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
  // CSS percentage that can't be dragged smoothly. The live drag height
  // itself is NOT React state — see handleSheetDragMove — pointermove fires
  // far faster than React can usefully re-render, and routing every move
  // through setState (the previous approach) was re-rendering the entire
  // App tree per event, which is what made the drag feel janky on real
  // phones. dragHeightRef is the synchronous source of truth for it,
  // written directly to the DOM during the drag and read back only once,
  // at release, for the snap/fling calculation.
  const mapFrameRef = useRef<HTMLDivElement>(null);
  const [frameHeight, setFrameHeight] = useState(0);
  const [sheetState, setSheetState] = useState<SheetState>('map');
  const dragHeightRef = useRef<number | null>(null);
  const [isDraggingSheet, setIsDraggingSheet] = useState(false);
  const dragStartRef = useRef<{ startY: number; startHeight: number; lastY: number; lastT: number; velocity: number } | null>(null);
  // Mobile-only double-swipe-down-to-exit (see handleHomeTouchStart/End
  // below) — tracked entirely separately from the sheet's own drag gesture
  // (dragStartRef above), which lives on the drag handle specifically and
  // is explicitly excluded from this one's eligible touch targets.
  const homeSwipeStartRef = useRef<{ y: number; t: number } | null>(null);
  const firstHomeSwipeAtRef = useRef<number | null>(null);
  const [homeExitNotice, setHomeExitNotice] = useState<string | null>(null);
  const homeExitNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const trimmedQuery = query.trim().toLowerCase();

  // Forgiving partial/substring relevance score against a listing's own
  // searchable text — not a rigid classifier. `includes()` already handles
  // partial input for free ("nort" is a substring of "north", "dos" of
  // "dosa"), so no separate fuzzy-matching library is needed for that part;
  // this only adds a *ranking* on top; whether something matches at all is
  // still plain substring containment. 0 = no match. Checked in this order
  // so a name hit always outranks a hit that only shows up in the note or
  // the resolved address — a listing named "Dosa Corner" should rank above
  // one that merely mentions dosa in passing.
  function textRelevance(l: ListingWithDistance, q: string): number {
    const name = l.name.toLowerCase();
    if (name.startsWith(q)) return 4;
    if (name.includes(q)) return 3;
    if ((l.location_label ?? '').toLowerCase().includes(q)) return 2;
    if ((l.note ?? '').toLowerCase().includes(q)) return 1;
    return 0;
  }

  // Local text match — name, note, AND location_label (e.g. "indiranagar"
  // matches a listing whose resolved address mentions it, even if its own
  // name/note never does). This is the search's first and primary pass —
  // area/geographic resolution (the debounced effect below) is a fallback
  // that only runs at all when this comes up empty, not a parallel source
  // merged in afterward. That's a deliberate change from this feature's
  // earlier "union" design: a query should mean one thing, not silently
  // blend two different kinds of match together — see the debounced effect
  // below for the one documented trade-off this reintroduces.
  const textMatches = useMemo(() => {
    if (!trimmedQuery) return [];
    return listingsWithDistance.filter((l) => textRelevance(l, trimmedQuery) > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingsWithDistance, trimmedQuery]);

  // Ranks text matches by relevance tier first (name > location_label >
  // note), then by proximity within a tier — nearest-to-viewer when their
  // location is known, else newest-first. Same fallback rule
  // AGENTS.md already documents for mobile's own list, just also applied
  // to relevance ties here.
  function sortTextMatches(list: ListingWithDistance[], q: string): ListingWithDistance[] {
    const sorted = [...list];
    sorted.sort((a, b) => {
      const byRelevance = textRelevance(b, q) - textRelevance(a, q);
      if (byRelevance !== 0) return byRelevance;
      if (userLocation) return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
      return Date.parse(b.created_at) - Date.parse(a.created_at);
    });
    return sorted;
  }

  // Ranks area-fallback matches nearest-to-the-searched-area-first — "closer
  // to the middle of Whitefield" is the relevant ordering for an area
  // search, distinct from "closer to the viewer" (that still applies to
  // plain browsing and to text matches above).
  function sortAreaMatches(list: ListingWithDistance[], center: { lat: number; lon: number } | null): ListingWithDistance[] {
    if (!center) return list;
    return [...list].sort((a, b) => distanceKm(center.lat, center.lon, a.latitude, a.longitude) - distanceKm(center.lat, center.lon, b.latitude, b.longitude));
  }

  // Memoized so this array's identity only changes when its real inputs do
  // — MapView re-fits the camera to it whenever the reference changes, so a
  // stable reference across unrelated re-renders (e.g. the results-dropdown
  // open/close state) stops that refit from firing and stomping on an
  // in-progress flyToCenter animation.
  //
  // No query -> every listing (unchanged browse default, cheapest-first
  // from the Supabase query). A query -> text matches win outright the
  // moment any exist (ranked by sortTextMatches); only when there are truly
  // none does the resolved geographic area's nearby listings (ranked by
  // sortAreaMatches) become the result; neither existing -> empty (the
  // list panel's own empty/add-place state handles that).
  const filtered = useMemo(() => {
    if (!trimmedQuery) return listingsWithDistance;
    if (textMatches.length > 0) return sortTextMatches(textMatches, trimmedQuery);
    if (areaListings.length > 0) return sortAreaMatches(areaListings, areaCenter);
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmedQuery, listingsWithDistance, textMatches, areaListings, areaCenter, userLocation]);

  // Nearest-first when the viewer's own location is known, else
  // newest-first — mobile's own always-on browse-time ordering (unchanged).
  function byLocationPriority(list: ListingWithDistance[]): ListingWithDistance[] {
    const sorted = [...list];
    if (userLocation) {
      sorted.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    } else {
      sorted.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    }
    return sorted;
  }

  // Mobile-only list ordering: while just browsing (no query), nearest/
  // newest-first as before. The moment a search is active, `filtered` is
  // already in its final, correct order (relevance+proximity, or
  // proximity-to-area) — re-sorting it here by raw viewer-distance would
  // silently undo the relevance ranking, so this now passes it through
  // unchanged in that case instead. Desktop/tablet/landscape use `filtered`
  // directly (see the JSX below) — no second list-only reorder needed there
  // either, for the same reason.
  const mobileListListings = useMemo(() => {
    if (!isMobilePortrait) return filtered;
    if (!trimmedQuery) return byLocationPriority(filtered);
    return filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, isMobilePortrait, userLocation, trimmedQuery]);

  // Shared by the debounced auto-search below and executeSearch (Enter/the
  // search icon/a dropdown pick) — the one place that turns a query string
  // into a geocoded center plus whichever of our own listings fall within
  // AREA_MATCH_RADIUS_KM of it. Pure: takes its inputs as arguments and
  // returns a result rather than touching state itself, so both call sites
  // can decide independently what to do with it (the debounce only updates
  // state; executeSearch also moves the camera). OLA's own predictions
  // (placeResults) are never shown as if they were Beggars Map listings —
  // they only ever feed the separate "add a new listing here" dropdown/pin
  // flow, exactly as before.
  //
  // The geographic center is the best NAME MATCH for the query
  // (bestPlaceMatch), not OLA's raw top prediction — OLA ranks predictions
  // mostly by proximity to `near`, not by how well the name matches the
  // query text (confirmed live: "Juicy Spot" biased at Bengaluru center
  // returned an unrelated street address as prediction #1, with the actual
  // "Juicy SPOT" restaurant only at #2, which used to make the area-match
  // radius check below run against the wrong point entirely). Falls back to
  // results[0] only when nothing clears bestPlaceMatch's similarity bar, so
  // a query that only resolves on proximity grounds still gets a center.
  async function resolveAreaMatches(q: string, near: { lat: number; lon: number }) {
    const results = await searchPlaces(q, { latitude: near.lat, longitude: near.lon });
    const top = bestPlaceMatch(q, results) ?? results[0];
    const center = top ? { lat: top.latitude, lon: top.longitude } : null;
    const nearby = center
      ? listingsWithDistance.filter((l) => distanceKm(center.lat, center.lon, l.latitude, l.longitude) <= AREA_MATCH_RADIUS_KM)
      : [];
    return { center, nearby, placeResults: results };
  }

  // Auto-search as the user types (debounced, so it doesn't fire an OLA
  // call on every keystroke): a query that matches our own listings by
  // name/note/location_label (textMatches, computed live above with no
  // debounce needed — it's local) is the whole answer, full stop — this
  // effect doesn't call OLA at all in that case, only stepping in as a
  // *fallback* once there's truly no local match, to resolve the query as
  // an area/landmark instead. This replaced an earlier "always geocode too,
  // then union the two result sets" design — deliberately dropped in favor
  // of one predictable answer per query; the one thing that trade-off gives
  // up is a listing whose own name happens to literally contain an area
  // name (e.g. "... Indiranagar ...") no longer being able to also surface
  // other, differently-named listings that are merely nearby that area — a
  // real but narrow edge case, and none of the current listings hit it.
  //
  // This effect only ever updates state for the *live-typing* preview list;
  // it deliberately never moves the map camera on its own (that stays tied
  // to an explicit "search executed" moment — see executeSearch) so the
  // view doesn't jump around mid-keystroke.
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    setAreaListings([]);
    setAreaCenter(null);
    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false;
      return;
    }
    if (!trimmedQuery) {
      setPlaceResults([]);
      setSearchPin(null);
      return;
    }
    if (textMatches.length > 0) {
      // A local match already answers the query outright — no OLA call
      // needed, and any previously-open landmark dropdown is stale now.
      setPlaceResults([]);
      setSearchResultsOpen(false);
      return;
    }
    searchDebounce.current = setTimeout(async () => {
      const near = userLocation ?? BENGALURU_CENTER;
      const { center, nearby, placeResults: results } = await resolveAreaMatches(query, near);
      setAreaCenter(center);
      setAreaListings(nearby);
      // Nearby Beggars Map listings and OLA's own place suggestions are two
      // independent answers to the same query, not alternatives — one must
      // never suppress the other. A query can simultaneously have existing
      // nearby listings AND be the name of a real place that isn't one of
      // them yet (this is exactly how the "Juicy Spot" bug happened: an
      // unrelated listing happened to be within AREA_MATCH_RADIUS_KM of the
      // resolved center, which used to wipe out the real "Juicy SPOT"
      // suggestion entirely instead of showing both). Always keep whatever
      // OLA found, regardless of what nearby turned out to be.
      setPlaceResults(results);
      setSearchResultsOpen(results.length > 0);
    }, 400);
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, [query, trimmedQuery, listingsWithDistance, textMatches, userLocation]);

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
  // sheet on selection instead (see selectListingCore below), so the list
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
  // The live drag height is applied imperatively (see handleSheetDragMove),
  // not through this — this is only what React itself renders: the current
  // snap state's own height, animated via CSS transition (see
  // .list-panel-outer's `dragging` class toggle below, which turns that
  // transition off only while a drag is actually in progress).
  const appliedSheetHeight = sheetSnaps[sheetState];

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
  // control in the same sense. selectListingCore's own forced MAP-mode
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
    // Written straight to the DOM, not React state — pointermove fires far
    // faster than React can usefully re-render (every event here used to
    // call setState on the whole App tree, which is what was making the
    // drag feel janky/stuttery on real phones). CSS custom properties
    // update instantly regardless of whether they're set by React's style
    // diffing or a direct .style mutation, so this is a purely visual
    // shortcut — nothing downstream (the CSS reading var(--sheet-h)) needs
    // to know the difference.
    mapFrameRef.current?.style.setProperty('--sheet-h', `${nextHeight}px`);

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

    const FLING_PX_PER_MS = 0.5;
    let next: SheetState;
    if (Math.abs(drag.velocity) > FLING_PX_PER_MS) {
      next = drag.velocity > 0 ? 'list' : 'map';
    } else {
      const midpoint = (sheetSnaps.map + sheetSnaps.list) / 2;
      next = releasedHeight > midpoint ? 'list' : 'map';
    }
    // Explicit, rather than relying on the setSheetState-triggered re-render
    // below to also fix up the DOM: if next === the current sheetState (a
    // small drag that snaps back to where it started), React bails out of
    // an identical state update and never re-renders at all — which would
    // otherwise leave --sheet-h stuck at the raw released height from the
    // drag instead of animating back to its snap point.
    mapFrameRef.current?.style.setProperty('--sheet-h', `${sheetSnaps[next]}px`);
    setSheetState(next);
  }

  // Moves the map camera to show a search's result set — deliberately a
  // separate mechanism from flyToCenter (used by listing selection and
  // location-picking) so nothing about search can ever touch the popup/pin
  // selection machinery. One point pans+zooms there (a single text match,
  // or an area with nothing nearby yet); several fit the camera to bounds
  // containing all of them.
  function focusMapOn(points: { lat: number; lng: number }[]) {
    if (points.length === 0) return;
    setSearchFocus((prev) => ({ points, token: (prev?.token ?? 0) + 1 }));
  }

  // The one place a query string actually gets resolved into a result and
  // the map moves to show it — used by both Enter and a dropdown pick (see
  // selectSearchResult) so the two converge on identical behavior instead
  // of the dropdown click being the only path that ever moved the camera.
  // Text matches (if any) always win outright over geographic resolution —
  // see textMatches/filtered above for why this is a fallback, not a union.
  async function executeSearch(q: string) {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    const trimmed = q.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    const matches = listingsWithDistance.filter((l) => textRelevance(l, lower) > 0);

    if (matches.length > 0) {
      setAreaListings([]);
      setAreaCenter(null);
      setPlaceResults([]);
      setSearchResultsOpen(false);
      setSearchPin(null);
      focusMapOn(matches.map((l) => ({ lat: l.latitude, lng: l.longitude })));
      return;
    }

    const near = userLocation ?? BENGALURU_CENTER;
    const { center, nearby, placeResults: results } = await resolveAreaMatches(trimmed, near);
    setAreaCenter(center);
    setAreaListings(nearby);
    // Nearby Beggars Map listings and OLA's own suggestions are independent
    // answers, never mutually suppressed — a query can have both, and
    // neither should hide the other just because the other happens to
    // exist (see resolveAreaMatches above). `results` is kept in
    // `placeResults` so a genuine suggestion is never thrown away — but
    // *executing* a search (Enter/the icon) is a deliberate "run this now"
    // action, and the map has already moved to show the answer, so the
    // dropdown itself always closes here regardless of what was found —
    // leaving it open would mean stale suggestions still hanging below the
    // search bar after the camera has already moved on. Refocusing the
    // input (see its onFocus handler) still reopens whatever's in
    // `placeResults`, so nothing found here is actually lost, just not
    // left open uninvited.
    setPlaceResults(results);
    setSearchResultsOpen(false);
    if (nearby.length > 0) {
      setSearchPin(null);
      focusMapOn(nearby.map((l) => ({ lat: l.latitude, lng: l.longitude })));
    } else if (center) {
      // Nothing of ours nearby — move the map to the resolved place anyway
      // so the search visibly goes somewhere even with nothing on the map
      // yet, instead of silently doing nothing.
      focusMapOn([{ lat: center.lat, lng: center.lon }]);
    }
  }

  // OLA's autocomplete already returns coordinates inline, no follow-up
  // details fetch needed before using it as a search center. Converges on
  // the exact same result pipeline executeSearch uses — a dropdown pick is
  // just a shortcut for "the geographic center is this exact point" rather
  // than a different kind of search.
  function selectSearchResult(place: PlaceSuggestion) {
    skipNextSearchRef.current = true;
    setQuery(place.name);
    setPlaceResults([]);
    setSearchResultsOpen(false);
    const center = { lat: place.latitude, lon: place.longitude };
    const nearby = listingsWithDistance.filter((l) => distanceKm(center.lat, center.lon, l.latitude, l.longitude) <= AREA_MATCH_RADIUS_KM);
    setAreaCenter(center);
    setAreaListings(nearby);
    if (nearby.length > 0) {
      setSearchPin(null);
      focusMapOn(nearby.map((l) => ({ lat: l.latitude, lng: l.longitude })));
    } else {
      // Nothing of ours at the picked place — offer the usual "add this
      // place" pin instead of leaving the user with only a moved camera.
      setSearchPin({ lat: place.latitude, lng: place.longitude });
      focusMapOn([{ lat: place.latitude, lng: place.longitude }]);
    }
  }

  // The one place that fully backs out of an active search without
  // selecting anything — the search box's own ✕ button, Escape, and (via
  // resetToHome below) the browser/edge-swipe back gesture all funnel
  // through either this or resetToHome. Deliberately narrower than
  // resetToHome: it only touches search state, so clearing a search while a
  // listing's popup happens to also be open (query and selectedListingId
  // are independent) doesn't also close that popup.
  function clearSearch() {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    setQuery('');
    setPlaceResults([]);
    setAreaListings([]);
    setAreaCenter(null);
    setSearchResultsOpen(false);
    if (!pickingLocation) setSearchPin(null);
  }

  // The shared part of selecting a listing, regardless of how it was
  // triggered — opens the same map-anchored popup (MapView's own, see
  // `hidePopup` below) on every viewport, mobile included, deliberately
  // never touching the camera itself. Camera movement is each caller's own
  // decision (see selectListingFromPin/selectListingFromList below) —
  // selection and camera movement used to be fused into one function that
  // always flew the camera, which is what made clicking a pin that's
  // already visible on-screen jump the map anyway.
  //
  // On mobile portrait, also forces the sheet back to MAP mode: if a list
  // tap happened while the sheet was expanded (LIST mode covers most of the
  // frame), the popup would otherwise render hidden behind it. This is what
  // makes "tapping a list row opens the same info as tapping a pin" actually
  // true in practice, not just in theory.
  function selectListingCore(id: string) {
    setSelectedListingId(id);
    setSearchPin(null);
    if (isMobilePortrait) setSheetState('map');
  }

  // Tapping a pin directly on the map: the listing is, by definition,
  // already exactly where the user just tapped — the camera must stay
  // completely untouched (center, zoom, everything) and only the popup
  // opens, anchored to that same pin via MapView's own continuous
  // measurement of its on-screen position (unrelated to camera state).
  function selectListingFromPin(id: string) {
    selectListingCore(id);
  }

  // Tapping a row in the list: unlike a pin, the listing might currently be
  // off-screen (that's the whole point of a list), so flying the camera
  // there — same pan+zoom mechanism a landmark search uses — is still the
  // right call here. Unchanged from before this split.
  function selectListingFromList(id: string) {
    selectListingCore(id);
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
    setSheetState('map');
    // An active search is one more "internal view" back/edge-swipe should
    // close rather than exiting the site (see hasOpenState below) — so
    // fully returning home clears it the same way it closes every other
    // view, same reasoning as clearSearch above just folded into the one
    // shared reset.
    setQuery('');
    setPlaceResults([]);
    setAreaListings([]);
    setAreaCenter(null);
    setSearchResultsOpen(false);
  }, []);

  // Whether the app is currently showing anything other than the plain
  // browsing map — every one of these is a distinct "internal view" a
  // browser back-press or edge-swipe should close rather than exiting the
  // site. An active search (non-empty query) is included so that a search
  // with no clean way to back out of it (e.g. "Indiranagar" resolving to no
  // on-map suggestion the user wants to pick) can still be dismissed with
  // the normal back gesture/button, not just by manually clearing the box.
  // The results dropdown's own open/closed state and a report popover stay
  // excluded — those are lighter-weight transient UI a back-press wouldn't
  // be expected to specifically target, and they close on their own (an
  // outside click, selecting a result) well before the query itself does.
  // Mobile portrait's LIST mode is included too — without it, expanding the
  // sheet doesn't push a history entry, so a back-press/edge-swipe while the
  // list is open has nothing of the app's own to consume and falls straight
  // through to real browser back navigation (exiting the site instead of
  // just collapsing the sheet back to MAP mode).
  const hasOpenState =
    showAdd || legalTab !== null || showAbout || selectedListingId !== null || trimmedQuery.length > 0 || sheetState === 'list';

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

  function showHomeExitNotice(message: string) {
    if (homeExitNoticeTimeoutRef.current) clearTimeout(homeExitNoticeTimeoutRef.current);
    setHomeExitNotice(message);
    homeExitNoticeTimeoutRef.current = setTimeout(() => setHomeExitNotice(null), 3200);
  }

  // Two deliberate downward swipes on the bare map surface (MAP mode's
  // "home" — the sheet is collapsed to its peek zone, nothing else open)
  // exit the mobile-web experience. A single web page has no way to
  // actually close its own tab/the browser/app — window.close() only works
  // on a tab the page itself opened via script — so the closest real
  // equivalent is handing the gesture to the browser's own back history.
  //
  // window.history.length can't reliably tell us whether there's actually
  // a *real* previous page to land on: this app's own modal-open/close
  // pushState/back() pairs (see hasOpenState's effect above) leave it
  // permanently inflated by one after the very first modal interaction in
  // the tab, even with nothing genuinely behind this page — so branching
  // the message on it would sometimes claim "leaving" when back() is
  // actually a same-document no-op. Rather than guess, always attempt
  // back() (harmless either way) and always show the same message that's
  // accurate regardless of what it actually did — this IS the platform
  // limitation being reported, not a claim about the outcome.
  function attemptHomeExit() {
    window.history.back();
    showHomeExitNotice("Taking you back as far as a web page can — closing a browser tab or app isn't something a page is allowed to do. Use your device's back button or close the tab to fully exit.");
  }

  // Only the bare map surface counts — not the list/sheet (its own drag
  // gesture already owns downward swipes there), not the search bar/Add
  // button/zoom/locate controls, and not the search-results dropdown.
  // Keeps this from ever firing off the back of an ordinary list
  // pull-up/pull-down or a drag on the sheet handle.
  function isHomeExitEligibleTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) return true;
    return !target.closest('.list-panel-outer, .map-overlay-row, .zoom-control, .locate-control, .map-search-results, .picking-dialog');
  }

  function handleHomeTouchStart(e: ReactTouchEvent<HTMLDivElement>) {
    if (!isMobilePortrait || sheetState !== 'map' || hasOpenState || e.touches.length !== 1 || !isHomeExitEligibleTarget(e.target)) {
      homeSwipeStartRef.current = null;
      return;
    }
    homeSwipeStartRef.current = { y: e.touches[0].clientY, t: performance.now() };
  }

  function handleHomeTouchEnd(e: ReactTouchEvent<HTMLDivElement>) {
    const start = homeSwipeStartRef.current;
    homeSwipeStartRef.current = null;
    const end = e.changedTouches[0];
    if (!start || !end) return;

    const deltaY = end.clientY - start.y;
    const deltaT = performance.now() - start.t;
    if (deltaY < HOME_SWIPE_MIN_DISTANCE_PX || deltaT > HOME_SWIPE_MAX_DURATION_MS) {
      // Not a fast, deliberate downward swipe — doesn't count as the first
      // half of a double-swipe, and cancels a pending one so two unrelated
      // slow drags can't accidentally add up to an exit.
      firstHomeSwipeAtRef.current = null;
      return;
    }

    const now = performance.now();
    if (firstHomeSwipeAtRef.current != null && now - firstHomeSwipeAtRef.current <= HOME_DOUBLE_SWIPE_WINDOW_MS) {
      firstHomeSwipeAtRef.current = null;
      attemptHomeExit();
    } else {
      firstHomeSwipeAtRef.current = now;
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand">
            <Logo size={26} />
            <span>Beggars Map</span>
          </div>
          <div className="brand-sub">Affordable eats in Bengaluru, ₹100 or under</div>
        </div>
        <button className="about-button" onClick={() => setShowAbout(true)}>About Us</button>
      </header>

      <main className="main">
        <section className="about-panel">
          <AboutContent />
        </section>

        <div className="map-panel">
          <p className="map-banner-tagline">Why do we call it Beggars Map? Why not? Why beat around the bush? 😄</p>

          <div
            className={`map-frame${isMobilePortrait && sheetState === 'list' && !pickingLocation ? ' list-mode-active' : ''}`}
            ref={mapFrameRef}
            style={frameHeight > 0 ? ({ '--sheet-h': `${appliedSheetHeight}px` } as CSSProperties) : undefined}
            onTouchStart={isMobilePortrait ? handleHomeTouchStart : undefined}
            onTouchEnd={isMobilePortrait ? handleHomeTouchEnd : undefined}
            onTouchCancel={isMobilePortrait ? handleHomeTouchEnd : undefined}
          >
            <MapView
              listings={filtered}
              onSelectListing={pickingLocation ? () => {} : selectListingFromPin}
              showLocate
              onMapClick={handleMapClick}
              flyToCenter={flyToCenter ?? undefined}
              searchFocus={searchFocus ?? undefined}
              searchPin={searchPin}
              selectedListingId={pickingLocation ? null : selectedListingId}
              onClosePopup={resetToHome}
              onListingUpdated={load}
              hidePopup={pickingLocation}
              selectedDistanceKm={
                isMobilePortrait ? listingsWithDistance.find((l) => l.id === selectedListingId)?.distanceKm ?? null : null
              }
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
                    // Enter must execute the search on the raw typed text —
                    // never requires a dropdown suggestion to be selected
                    // first. preventDefault is defensive (this input isn't
                    // inside a <form>, so there's no submit to suppress
                    // today, but Enter shouldn't ever risk a default action
                    // here regardless).
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      executeSearch(query);
                    }
                    // Escape always fully backs out of the search (not just
                    // closing the suggestion dropdown) — the one keyboard
                    // way to "dismiss/exit search without selecting
                    // anything" a random/no-result query.
                    else if (e.key === 'Escape') clearSearch();
                  }}
                  placeholder="Search dish, area, landmark, or restaurant"
                />
                {query ? (
                  <button className="search-clear-button" onClick={clearSearch} aria-label="Clear search">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <line x1="5" y1="5" x2="19" y2="19" />
                      <line x1="19" y1="5" x2="5" y2="19" />
                    </svg>
                  </button>
                ) : (
                  <button className="search-icon-button" onClick={() => executeSearch(query)} aria-label="Search">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                      <circle cx="11" cy="11" r="7" />
                      <line x1="21" y1="21" x2="16.2" y2="16.2" />
                    </svg>
                  </button>
                )}
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

            {homeExitNotice ? <div className="home-exit-toast">{homeExitNotice}</div> : null}

            <div
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
                    <p className="loading-text">Loading affordable eats…</p>
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
                    onClick={() => selectListingFromList(listing.id)}
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
