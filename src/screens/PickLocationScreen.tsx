import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type NativeSyntheticEvent } from 'react-native';
import { Camera, Map } from '@maplibre/maplibre-react-native';
import type { MapRef, ViewStateChangeEvent } from '@maplibre/maplibre-react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { vectorStyleUrl } from '../lib/olaMaps';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type PickLocationRoute = RouteProp<RootStackParamList, 'PickLocation'>;

const DEFAULT_CENTER: [number, number] = [77.5946, 12.9716]; // Bengaluru

export default function PickLocationScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<PickLocationRoute>();
  const mapRef = useRef<MapRef>(null);
  const styleUrl = vectorStyleUrl();

  const initialCenter: [number, number] =
    params?.initialLongitude != null && params?.initialLatitude != null
      ? [params.initialLongitude, params.initialLatitude]
      : DEFAULT_CENTER;

  const [center, setCenter] = useState<[number, number]>(initialCenter);

  function confirm() {
    navigation.navigate('AddListing', { pickedLatitude: center[1], pickedLongitude: center[0] });
  }

  if (!styleUrl) {
    return (
      <View style={[styles.container, styles.missingKey]}>
        <Text style={styles.missingKeyText}>Set EXPO_PUBLIC_OLA_MAPS_API_KEY to pick a location on the map.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Map
        ref={mapRef}
        style={styles.map}
        mapStyle={styleUrl}
        onRegionDidChange={(event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
          setCenter(event.nativeEvent.center);
        }}
      >
        <Camera initialViewState={{ center: initialCenter, zoom: 15 }} />
      </Map>

      <View pointerEvents="none" style={styles.pinWrap}>
        <View style={styles.pin} />
        <View style={styles.pinTip} />
      </View>

      <View style={styles.footer}>
        <Text style={styles.hint}>Move the map to position the pin</Text>
        <Pressable style={styles.confirmButton} onPress={confirm}>
          <Text style={styles.confirmButtonText}>Use this location</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  map: { width: '100%', height: '100%' },
  missingKey: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  missingKeyText: { color: '#888', textAlign: 'center' },
  pinWrap: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginLeft: -14,
    marginTop: -34,
    alignItems: 'center',
  },
  pin: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#0a7d3c',
    borderWidth: 3,
    borderColor: '#fff',
  },
  pinTip: {
    width: 4,
    height: 10,
    backgroundColor: '#0a7d3c',
    marginTop: -2,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    paddingBottom: 32,
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
  },
  hint: { textAlign: 'center', color: '#888', marginBottom: 12 },
  confirmButton: { backgroundColor: '#0a7d3c', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  confirmButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
