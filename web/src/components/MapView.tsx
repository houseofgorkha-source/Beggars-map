import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { transformRequest, vectorStyleUrl } from '../lib/olaMaps';
import type { Listing } from '../types';

const DEFAULT_CENTER: [number, number] = [77.5946, 12.9716]; // Bengaluru

type Props = {
  listings: Listing[];
  onSelectListing: (id: string) => void;
  pickMode?: boolean;
  pickedCenter?: [number, number];
  onPickedCenterChange?: (center: [number, number]) => void;
};

export default function MapView({ listings, onSelectListing, pickMode, pickedCenter, onPickedCenterChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    const styleUrl = vectorStyleUrl();
    if (!containerRef.current || !styleUrl) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl,
      center: pickedCenter ?? DEFAULT_CENTER,
      zoom: 12,
      transformRequest,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    mapRef.current = map;

    if (pickMode) {
      map.on('moveend', () => {
        const c = map.getCenter();
        onPickedCenterChange?.([c.lng, c.lat]);
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
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  return <div ref={containerRef} className="map-container" />;
}
