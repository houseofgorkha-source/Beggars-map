import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Camera, Map, Marker, UserLocation } from '@maplibre/maplibre-react-native';
import type { CameraRef, PressEvent } from '@maplibre/maplibre-react-native';
import type { NativeSyntheticEvent } from 'react-native';
import { boundsForPoints, vectorStyleUrl } from '../lib/olaMaps';
import type { Listing } from '../types/database';

type Props = {
  listings: Listing[];
  onSelectListing: (listingId: string) => void;
  onLongPress?: (latitude: number, longitude: number) => void;
  flyToCenter?: { latitude: number; longitude: number; token: number };
};

export default function ListingsMap({ listings, onSelectListing, onLongPress, flyToCenter }: Props) {
  const styleUrl = vectorStyleUrl();
  const cameraRef = useRef<CameraRef>(null);
  const bounds = useMemo(() => boundsForPoints(listings.map((l) => ({ latitude: l.latitude, longitude: l.longitude }))), [listings]);

  useEffect(() => {
    if (!flyToCenter) return;
    cameraRef.current?.flyTo({
      center: [flyToCenter.longitude, flyToCenter.latitude],
      zoom: 15,
      duration: 1200,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyToCenter?.token]);

  if (!styleUrl) {
    return (
      <View style={[styles.map, styles.missingKey]}>
        <Text style={styles.missingKeyText}>Set EXPO_PUBLIC_OLA_MAPS_API_KEY to show the map.</Text>
      </View>
    );
  }

  return (
    <Map
      style={styles.map}
      mapStyle={styleUrl}
      onLongPress={
        onLongPress
          ? (event: NativeSyntheticEvent<PressEvent>) => {
              const [longitude, latitude] = event.nativeEvent.lngLat;
              onLongPress(latitude, longitude);
            }
          : undefined
      }
    >
      <Camera
        ref={cameraRef}
        initialViewState={
          bounds
            ? { bounds, padding: { left: 40, right: 40, top: 40, bottom: 40 } }
            : { center: [77.5946, 12.9716], zoom: 12 }
        }
      />
      <UserLocation animated accuracy />
      {listings.map((listing) => (
        <Marker
          key={listing.id}
          lngLat={[listing.longitude, listing.latitude]}
          anchor="bottom"
          onPress={() => onSelectListing(listing.id)}
        >
          <View style={styles.pin}>
            <Text style={styles.pinText}>₹{listing.price_rupees}</Text>
          </View>
        </Marker>
      ))}
    </Map>
  );
}

const styles = StyleSheet.create({
  map: { width: '100%', height: '100%', overflow: 'hidden' },
  missingKey: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#f2f2f2', padding: 16 },
  missingKeyText: { color: '#888', textAlign: 'center' },
  pin: {
    backgroundColor: '#ec4899',
    borderRadius: 14,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 2,
    borderColor: '#fff',
  },
  pinText: { color: '#fff', fontWeight: '700', fontSize: 12 },
});
