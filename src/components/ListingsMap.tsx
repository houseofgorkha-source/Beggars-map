import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Camera, Map, Marker, UserLocation } from '@maplibre/maplibre-react-native';
import { boundsForPoints, vectorStyleUrl } from '../lib/olaMaps';
import type { Listing } from '../types/database';

type Props = {
  listings: Listing[];
  onSelectListing: (listingId: string) => void;
};

export default function ListingsMap({ listings, onSelectListing }: Props) {
  const styleUrl = vectorStyleUrl();
  const bounds = useMemo(() => boundsForPoints(listings.map((l) => ({ latitude: l.latitude, longitude: l.longitude }))), [listings]);

  if (!styleUrl) {
    return (
      <View style={[styles.map, styles.missingKey]}>
        <Text style={styles.missingKeyText}>Set EXPO_PUBLIC_OLA_MAPS_API_KEY to show the map.</Text>
      </View>
    );
  }

  return (
    <Map style={styles.map} mapStyle={styleUrl}>
      <Camera
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
    backgroundColor: '#0a7d3c',
    borderRadius: 14,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 2,
    borderColor: '#fff',
  },
  pinText: { color: '#fff', fontWeight: '700', fontSize: 12 },
});
