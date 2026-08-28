import { useCallback, useEffect, useRef, useState } from 'react';
import { getMapId, hasGoogleMapsKey, loadMapsLibrary, loadMarkerLibrary } from '../lib/googleMaps';
import ListingDetailModal from './ListingDetailModal';
import type { Listing } from '../types';

const DEFAULT_CENTER = { lat: 12.9716, lng: 77.5946 }; // Bengaluru

type Props = {
  listings: Listing[];
  onSelectListing: (id: string) => void;
  showLocate?: boolean;
  onMapClick?: (latitude: number, longitude: number) => void;
  flyToCenter?: { center: [number, number]; token: number };
  // A landmark search result that isn't one of our own listings (so it has
  // no price-pill marker of its own) — rendered as a distinct pin so the
  // searched point is visibly pinpointed, not just implied by camera
  // position. null/undefined clears it.
  searchPin?: { lat: number; lng: number } | null;
  // The currently selected listing (if any) — its marker is rendered
  // larger/highlighted (`.map-pin-selected`) so it's unambiguous which pin
  // the open detail card belongs to, at the exact same lat/lng every other
  // marker for that listing already uses (no separate/approximate position).
  selectedListingId?: string | null;
  // Closes the popup card (its own ✕, report/vote/delete flows use this to
  // report back up) — App.tsx wires this to the same "return to home" reset
  // every other close action uses.
  onClosePopup?: () => void;
  // Forwarded to the popup card's onUpdated (vote/delete change the
  // listing) so the caller's own listings reload the same way it already
  // does for the side-panel's card.
  onListingUpdated?: () => void;
  // True on portrait mobile only, where App.tsx already renders this exact
  // same compact card in its own bottom-sheet peek zone — showing it a
  // second time, anchored to the pin, would just duplicate that.
  hidePopup?: boolean;
};

export default function MapView({
  listings,
  onSelectListing,
  showLocate,
  onMapClick,
  flyToCenter,
  searchPin,
  selectedListingId,
  onClosePopup,
  onListingUpdated,
  hidePopup,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const userMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const searchPinMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  // Tracks the selected listing's on-screen pixel position (see the popup
  // effect below) so the popup can be a plain div we fully control —
  // deliberately NOT a Google InfoWindow. InfoWindow content renders inside
  // Google's own nested map panes, which bundle the base map tiles and every
  // overlay under one shared stacking rank from any *sibling* element's
  // point of view (like .list-panel-outer) — there is no z-index that puts
  // an InfoWindow above the side panel without also putting the base map
  // tiles above it, which would break the "panel floats over the map" look
  // entirely. A plain sibling div has no such bundling problem.
  const popupTrackerListenersRef = useRef<google.maps.MapsEventListener[]>([]);
  const popupRafRef = useRef<number | null>(null);
  // The selected listing's own pin content element (set in the markers
  // effect below) — the popup's position is measured directly from this via
  // getBoundingClientRect() rather than recomputed independently through
  // Google's Projection API, which is what AdvancedMarkerElement itself
  // already uses internally to position this exact element correctly. That
  // sidesteps needing our own lat/lng-to-pixel math to agree with Google's.
  const selectedMarkerElRef = useRef<HTMLDivElement | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ x: number; y: number } | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const hasFitInitialBoundsRef = useRef(false);

  const [mapLoading, setMapLoading] = useState(true);
  const [mapError, setMapError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const hasKey = hasGoogleMapsKey();

  // Kept in a ref so the click handler always calls the latest callback
  // without forcing the map-init effect (which only depends on
  // [hasKey, retryKey]) to tear down and recreate the map every render.
  const onMapClickRef = useRef(onMapClick);
  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  useEffect(() => {
    if (!containerRef.current || !hasKey) return;

    let cancelled = false;
    setMapLoading(true);
    setMapError(false);

    // Google doesn't emit a reliable "failed to load" event on the Map
    // object itself (a bad/restricted key just logs to the console and
    // shows a degraded/watermarked map) — same approach as before: decide
    // "failed" purely by whether the map ever goes idle in time.
    const loadTimeout = setTimeout(() => {
      if (!cancelled) {
        setMapLoading(false);
        setMapError(true);
      }
    }, 15000);

    let wheelHandler: ((e: WheelEvent) => void) | null = null;
    const container = containerRef.current;

    (async () => {
      try {
        const { Map } = await loadMapsLibrary();
        await loadMarkerLibrary();
        if (cancelled || !containerRef.current) return;

        const mapId = getMapId();
        const map = new Map(containerRef.current, {
          center: DEFAULT_CENTER,
          zoom: 12,
          mapId,
          disableDefaultUI: true,
          // Google's built-in zoom control is a fixed vertical pair we can't
          // restyle (no size/orientation option in the current API) — a
          // custom horizontal pill (`.zoom-control` below) replaces it
          // instead, same pattern as the custom locate-me button.
          zoomControl: false,
          gestureHandling: 'greedy',
          // Whatever the map is currently centered on — a searched landmark,
          // a selected listing — must stay exactly centered through a zoom.
          // Google's native scroll-wheel zoom pivots on the cursor instead
          // (like consumer Google Maps), which drags that point away from
          // center unless the cursor happens to sit exactly on it. Disable
          // the native handler and drive zoom manually below so it always
          // keeps the center fixed. (Pinch-zoom on touch has no equivalent
          // override in the Maps JS API — this only covers wheel/trackpad.)
          scrollwheel: false,
        });
        mapRef.current = map;

        if (container) {
          wheelHandler = (e: WheelEvent) => {
            e.preventDefault();
            const currentZoom = map.getZoom() ?? 12;
            const nextZoom = currentZoom + (e.deltaY < 0 ? 0.5 : -0.5);
            map.setZoom(Math.min(20, Math.max(3, nextZoom)));
          };
          container.addEventListener('wheel', wheelHandler, { passive: false });
        }

        google.maps.event.addListenerOnce(map, 'tilesloaded', () => {
          clearTimeout(loadTimeout);
          if (!cancelled) setMapLoading(false);
        });

        map.addListener('click', (e: google.maps.MapMouseEvent) => {
          if (e.latLng) onMapClickRef.current?.(e.latLng.lat(), e.latLng.lng());
        });

        const resizeObserver = new ResizeObserver(() => {
          const center = map.getCenter();
          google.maps.event.trigger(map, 'resize');
          if (center) map.setCenter(center);
        });
        resizeObserver.observe(containerRef.current);
        resizeObserverRef.current = resizeObserver;
      } catch (err) {
        console.warn('Google Maps failed to load:', err);
        clearTimeout(loadTimeout);
        if (!cancelled) {
          setMapLoading(false);
          setMapError(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(loadTimeout);
      if (wheelHandler && container) container.removeEventListener('wheel', wheelHandler);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      markersRef.current.forEach((m) => (m.map = null));
      markersRef.current = [];
      userMarkerRef.current = null;
      searchPinMarkerRef.current = null;
      popupTrackerListenersRef.current.forEach((l) => l.remove());
      popupTrackerListenersRef.current = [];
      if (popupRafRef.current != null) cancelAnimationFrame(popupRafRef.current);
      popupRafRef.current = null;
      selectedMarkerElRef.current = null;
      setPopupPosition(null);
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKey, retryKey]);

  // Keep markers in sync with listings, and rebuild them on selection
  // changes too so the selected one's marker gets its highlighted style.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapLoading) return;

    let cancelled = false;

    (async () => {
      const { AdvancedMarkerElement } = await loadMarkerLibrary();
      if (cancelled) return;

      markersRef.current.forEach((m) => (m.map = null));
      markersRef.current = [];
      selectedMarkerElRef.current = null;

      listings.forEach((listing) => {
        const isSelected = listing.id === selectedListingId;
        const el = document.createElement('div');
        el.className = isSelected ? 'map-pin map-pin-selected' : 'map-pin';
        el.textContent = `₹${listing.price_rupees}`;
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          onSelectListing(listing.id);
        });
        if (isSelected) selectedMarkerElRef.current = el;

        const marker = new AdvancedMarkerElement({
          map,
          position: { lat: listing.latitude, lng: listing.longitude },
          content: el,
          // Above every other listing pin so the highlighted ring/scale
          // doesn't get visually clipped underneath a neighboring marker.
          zIndex: isSelected ? 1 : undefined,
        });
        markersRef.current.push(marker);
      });

      // Fit the camera to all listings only once, the first time they load —
      // not on every listings-array change. A reference-equality "skip if
      // this update came from a search selection" guard used to live here,
      // but it was fragile: any later re-render that produced a new
      // `listings` array (e.g. typing further, or a listings reload) while
      // `flyToCenter` itself happened to be unchanged would still pass the
      // guard and fitBounds would snap the camera back, stomping whatever
      // the user had just searched/panned to. Fitting once up front and
      // leaving the camera alone afterwards removes that failure mode
      // entirely — flyToCenter (search) and user gestures are the only
      // things that move the camera from then on.
      if (listings.length > 0 && !hasFitInitialBoundsRef.current) {
        hasFitInitialBoundsRef.current = true;
        const bounds = new google.maps.LatLngBounds();
        listings.forEach((l) => bounds.extend({ lat: l.latitude, lng: l.longitude }));
        map.fitBounds(bounds, 60);
        google.maps.event.addListenerOnce(map, 'bounds_changed', () => {
          const zoom = map.getZoom();
          if (zoom !== undefined && zoom > 15) map.setZoom(15);
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [listings, onSelectListing, mapLoading, selectedListingId]);

  // Pan/zoom to a searched landmark. Keyed on the token (not the center
  // value itself) so re-selecting the same coordinates still moves the
  // camera — a bare {lat,lng} pair can't signal "do this again" on its own.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyToCenter || mapLoading) return;
    map.panTo({ lat: flyToCenter.center[1], lng: flyToCenter.center[0] });
    map.setZoom(16);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyToCenter?.token, mapLoading]);

  // A search-result pin for a landmark that isn't one of our own listings.
  // Kept separate from the listing markers effect above (which only runs in
  // browse mode and rebuilds on every `listings` change) so this can't be
  // wiped out or fought over by that effect.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapLoading) return;

    if (!searchPin) {
      if (searchPinMarkerRef.current) {
        searchPinMarkerRef.current.map = null;
        searchPinMarkerRef.current = null;
      }
      return;
    }

    let cancelled = false;
    (async () => {
      const { AdvancedMarkerElement } = await loadMarkerLibrary();
      if (cancelled) return;

      if (searchPinMarkerRef.current) {
        searchPinMarkerRef.current.position = searchPin;
      } else {
        const el = document.createElement('div');
        el.className = 'search-pin';
        // A real drop-pin shape (matching how every other location on this
        // map is marked) instead of a plain circle — drawn so the pin's
        // point, not just its bounding box, sits exactly at the bottom
        // center of the element, which is where AdvancedMarkerElement
        // anchors content by default. No label/popup content — just the
        // pin, per how this marker is meant to be used everywhere
        // (current-location, manual pick, and landmark search all share
        // this one marker).
        el.innerHTML =
          '<svg width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">' +
          '<path d="M13 0C5.82 0 0 5.82 0 13c0 9.75 13 21 13 21s13-11.25 13-21C26 5.82 20.18 0 13 0z" fill="#ec4899" stroke="#fff" stroke-width="2"/>' +
          '<circle cx="13" cy="13" r="4.5" fill="#fff"/>' +
          '</svg>';
        searchPinMarkerRef.current = new AdvancedMarkerElement({
          map,
          position: searchPin,
          content: el,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchPin, mapLoading]);

  // The selected listing's own popup, right at its pin — the exact same
  // compact card used everywhere else in the app (name, price, note,
  // freshness, vote, directions, report). Positioned by directly measuring
  // the selected marker's own pin element (selectedMarkerElRef, set in the
  // markers effect above) via getBoundingClientRect() — deliberately not
  // Google's Projection API (fromLatLngToDivPixel), which proved unreliable
  // here (empirically returning (0,0)-ish for coordinates that very much
  // aren't at the map's origin, independent of raster/vector rendering
  // mode). AdvancedMarkerElement already positions the pin correctly via
  // whatever internal mechanism Google uses, so measuring its real rendered
  // position sidesteps needing our own projection math to agree with it.
  // Re-measures every animation frame while a popup is open — pan/zoom
  // isn't accompanied by a discrete "moved" event we can rely on (the pin
  // itself just glides continuously), so this is what keeps the popup
  // glued to it. Skipped on portrait mobile (hidePopup) — App.tsx already
  // shows this same card in its bottom-sheet peek zone there, so a second
  // copy anchored to the pin would just be a duplicate.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapLoading) return;

    if (popupRafRef.current != null) cancelAnimationFrame(popupRafRef.current);
    popupRafRef.current = null;
    setPopupPosition(null);

    if (hidePopup) return;
    const listing = listings.find((l) => l.id === selectedListingId);
    if (!listing) return;

    const containerEl = containerRef.current;
    if (!containerEl) return;

    function measure() {
      const pinEl = selectedMarkerElRef.current;
      if (pinEl && containerEl) {
        const pinRect = pinEl.getBoundingClientRect();
        const containerRect = containerEl.getBoundingClientRect();
        setPopupPosition({
          x: pinRect.left + pinRect.width / 2 - containerRect.left,
          // Google's InfoWindow used to auto-pan the map so a popup near the
          // viewport edge always stayed fully visible — a plain positioned
          // div has no equivalent, so a pin close to the top of a short
          // frame (routine in mobile-landscape, where the whole frame can
          // be well under 400px tall) could otherwise open the card
          // underneath the search bar. Clamping to a minimum keeps the
          // whole card below that row; the tail just won't perfectly meet
          // the pin in that specific case, which is a minor, rare tradeoff
          // against actually being obscured.
          y: Math.max(pinRect.top - containerRect.top, 190),
        });
      }
      popupRafRef.current = requestAnimationFrame(measure);
    }
    popupRafRef.current = requestAnimationFrame(measure);

    return () => {
      if (popupRafRef.current != null) cancelAnimationFrame(popupRafRef.current);
      popupRafRef.current = null;
    };
  }, [listings, selectedListingId, mapLoading, hidePopup]);

  const zoomBy = useCallback((delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    const currentZoom = map.getZoom() ?? 12;
    map.setZoom(Math.min(20, Math.max(3, currentZoom + delta)));
  }, []);

  const locateMe = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!navigator.geolocation) {
      setLocateError("Your browser doesn't support location.");
      return;
    }

    setLocating(true);
    setLocateError(null);

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        setLocating(false);

        const { AdvancedMarkerElement } = await loadMarkerLibrary();
        if (!userMarkerRef.current) {
          const el = document.createElement('div');
          el.className = 'user-location-dot';
          userMarkerRef.current = new AdvancedMarkerElement({
            map,
            position: { lat: latitude, lng: longitude },
            content: el,
          });
        } else {
          userMarkerRef.current.position = { lat: latitude, lng: longitude };
        }

        map.panTo({ lat: latitude, lng: longitude });
        map.setZoom(14);
      },
      (err) => {
        setLocating(false);
        setLocateError(
          err.code === err.PERMISSION_DENIED
            ? 'Location access denied. Allow it in your browser settings to use this.'
            : "Couldn't get your location. Try again."
        );
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);

  if (!hasKey) {
    return (
      <div className="map-container map-message-state">
        <p>Map unavailable — missing Google Maps API key.</p>
      </div>
    );
  }

  return (
    <div className="map-container-wrap">
      <div ref={containerRef} className="map-container" />

      {mapLoading ? (
        <div className="map-overlay-state">
          <span className="spinner" aria-hidden="true" />
        </div>
      ) : null}

      {mapError ? (
        <div className="map-overlay-state">
          <p>Map failed to load.</p>
          <button
            className="secondary-button"
            onClick={() => {
              setMapError(false);
              setRetryKey((k) => k + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {!mapLoading && !mapError ? (
        <div className="zoom-control">
          <button className="zoom-button" onClick={() => zoomBy(-1)} aria-label="Zoom out">
            −
          </button>
          <span className="zoom-control-divider" aria-hidden="true" />
          <button className="zoom-button" onClick={() => zoomBy(1)} aria-label="Zoom in">
            +
          </button>
        </div>
      ) : null}

      {showLocate && !mapLoading && !mapError ? (
        <div className="locate-control">
          <button
            className="locate-button"
            onClick={locateMe}
            disabled={locating}
            aria-label="Use my location"
            title="Use my location"
          >
            {locating ? <span className="spinner spinner-small" aria-hidden="true" /> : '◎'}
          </button>
          {locateError ? <div className="locate-error">{locateError}</div> : null}
        </div>
      ) : null}

      {popupPosition && selectedListingId ? (
        <div className="map-popup-anchor" style={{ transform: `translate(${popupPosition.x}px, ${popupPosition.y}px)` }}>
          <div className="map-popup-card">
            <ListingDetailModal
              compact
              listingId={selectedListingId}
              onClose={() => onClosePopup?.()}
              onUpdated={onListingUpdated}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
