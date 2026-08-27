import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { transformRequest, vectorStyleUrl } from '../lib/olaMaps';
import { reverseGeocode } from '../lib/geocoding';
import type { Listing } from '../types';

const DEFAULT_CENTER: [number, number] = [77.5946, 12.9716]; // Bengaluru

export type SelectedMapListing = Listing & { avgRating: number | null; ratingCount: number };

type Props = {
  listings: Listing[];
  onSelectListing: (id: string) => void;
  pickMode?: boolean;
  pickedCenter?: [number, number];
  onPickedCenterChange?: (center: [number, number]) => void;
  showLocate?: boolean;
  selectedListing?: SelectedMapListing | null;
  onMapClick?: (latitude: number, longitude: number) => void;
};

// Built as real DOM nodes rather than an interpolated HTML string — a
// user-controlled field (photo_url, writable via any raw authenticated
// insert/update, not just the app's own upload flow) landing in a string
// concatenated into `src="${...}"` would let it break out of the attribute
// and inject arbitrary markup/handlers. Setting `.src` as a DOM property
// instead has no such escaping hazard, whatever the string contains.
function buildPopupContent(listing: SelectedMapListing, address: string) {
  const root = document.createElement('div');

  if (listing.photo_url) {
    const img = document.createElement('img');
    img.className = 'listing-popup-photo';
    img.src = listing.photo_url;
    img.alt = '';
    root.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'listing-popup-body';

  const name = document.createElement('div');
  name.className = 'listing-popup-name';
  name.textContent = `${listing.name} — ₹${listing.price_rupees}`;
  body.appendChild(name);

  const ratingEl = document.createElement('div');
  ratingEl.className = 'listing-popup-rating';
  ratingEl.textContent =
    listing.avgRating !== null ? `★ ${listing.avgRating.toFixed(1)} (${listing.ratingCount})` : 'No ratings yet';
  body.appendChild(ratingEl);

  const addressEl = document.createElement('div');
  addressEl.className = 'listing-popup-address';
  addressEl.textContent = address;
  body.appendChild(addressEl);

  root.appendChild(body);
  return root;
}

export default function MapView({
  listings,
  onSelectListing,
  pickMode,
  pickedCenter,
  onPickedCenterChange,
  showLocate,
  selectedListing,
  onMapClick,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const [mapLoading, setMapLoading] = useState(true);
  const [mapError, setMapError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const styleUrl = vectorStyleUrl();

  // Kept in a ref so the click handler always calls the latest callback
  // without forcing the map-init effect (which only depends on
  // [styleUrl, retryKey]) to tear down and recreate the map every render.
  const onMapClickRef = useRef(onMapClick);
  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  useEffect(() => {
    if (!containerRef.current || !styleUrl) return;

    setMapLoading(true);
    setMapError(false);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl,
      center: pickedCenter ?? DEFAULT_CENTER,
      zoom: 12,
      transformRequest,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    // MapLibre's 'error' event fires for plenty of non-fatal things —
    // missing sprite icons, individual tile hiccups — often before the
    // map has even finished its initial load, so it can't reliably tell
    // us the map actually failed. Just log errors for debugging, and
    // decide "failed" purely by whether 'load' ever fires in time.
    const loadTimeout = setTimeout(() => {
      setMapLoading(false);
      setMapError(true);
    }, 15000);
    map.once('load', () => {
      clearTimeout(loadTimeout);
      setMapLoading(false);
    });
    map.on('error', (e) => {
      console.warn('MapLibre error:', e.error);
    });
    mapRef.current = map;

    if (pickMode) {
      map.on('moveend', () => {
        const c = map.getCenter();
        onPickedCenterChange?.([c.lng, c.lat]);
      });
    } else {
      // Marker click handlers stopPropagation, so this only fires for a
      // click on empty map — clicking an existing pin never reaches here.
      map.on('click', (e) => {
        onMapClickRef.current?.(e.lngLat.lat, e.lngLat.lng);
      });
    }

    // maplibre-gl measures the container's size once on init. In a flex
    // layout the container can still be settling (or later resize, e.g. the
    // window or the modal it's in changing size), so the canvas ends up the
    // wrong size/position — force a re-measure whenever the container itself
    // resizes.
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);

    return () => {
      clearTimeout(loadTimeout);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      userMarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl, retryKey]);

  // Keep markers in sync with listings (browse mode only).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || pickMode) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    listings.forEach((listing) => {
      const el = document.createElement('div');
      el.className = 'map-pin';
      el.textContent = `₹${listing.price_rupees}`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelectListing(listing.id);
      });

      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([listing.longitude, listing.latitude])
        .addTo(map);
      markersRef.current.push(marker);
    });

    if (listings.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      listings.forEach((l) => bounds.extend([l.longitude, l.latitude]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 0 });
    }
  }, [listings, pickMode, onSelectListing]);

  // Show a popup with address/rating/photo for the selected listing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    popupRef.current?.remove();
    popupRef.current = null;

    if (!selectedListing) return;

    let cancelled = false;
    const popup = new maplibregl.Popup({ closeButton: true, className: 'listing-popup', maxWidth: '240px' })
      .setLngLat([selectedListing.longitude, selectedListing.latitude])
      .setDOMContent(buildPopupContent(selectedListing, 'Loading address…'))
      .addTo(map);
    popupRef.current = popup;

    map.panTo([selectedListing.longitude, selectedListing.latitude], { duration: 500 });

    reverseGeocode(selectedListing.latitude, selectedListing.longitude).then((address) => {
      if (cancelled || popupRef.current !== popup) return;
      popup.setDOMContent(
        buildPopupContent(selectedListing, address ?? `${selectedListing.latitude.toFixed(5)}, ${selectedListing.longitude.toFixed(5)}`)
      );
    });

    return () => {
      cancelled = true;
    };
  }, [selectedListing]);

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
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setLocating(false);

        if (!userMarkerRef.current) {
          const el = document.createElement('div');
          el.className = 'user-location-dot';
          userMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat([longitude, latitude]).addTo(map);
        } else {
          userMarkerRef.current.setLngLat([longitude, latitude]);
        }

        map.flyTo({ center: [longitude, latitude], zoom: 14, duration: 800 });
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

  if (!styleUrl) {
    return (
      <div className="map-container map-message-state">
        <p>Map unavailable — missing OLA Maps API key.</p>
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
    </div>
  );
}
