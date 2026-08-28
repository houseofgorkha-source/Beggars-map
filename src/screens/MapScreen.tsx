import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { searchPlaces, type PlaceSuggestion } from '../lib/olaMaps';
import ListingsMap from '../components/ListingsMap';
import type { RootStackParamList } from '../navigation/types';
import type { Listing } from '../types/database';

type Nav = NativeStackNavigationProp<RootStackParamList>;

type ListingWithDistance = Listing & {
  distanceKm: number | null;
  voteCount: number;
};

const CITIES = ['Bengaluru', 'Delhi', 'Mumbai', 'Kolkata', 'Chennai', 'Guwahati'];

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function MapScreen() {
  const navigation = useNavigation<Nav>();
  const { session, loading: authLoading } = useAuth();
  const [listings, setListings] = useState<ListingWithDistance[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);

  const [placeResults, setPlaceResults] = useState<PlaceSuggestion[]>([]);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flyToCenter, setFlyToCenter] = useState<{ latitude: number; longitude: number; token: number } | null>(null);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const pos = await Location.getCurrentPositionAsync({});
      setUserLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude });
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('listings').select('*, votes(count)').order('price_rupees', { ascending: true });

    if (!error && data) {
      const mapped: ListingWithDistance[] = data.map((row: any) => ({
        ...row,
        voteCount: row.votes?.[0]?.count ?? 0,
        distanceKm: userLocation ? distanceKm(userLocation.lat, userLocation.lon, row.latitude, row.longitude) : null,
      }));
      setListings(mapped);
    }
    setLoading(false);
  }, [userLocation]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // Landmark search on the browse map — separate from the substring filter
  // below (which runs on every keystroke, no debounce needed since it's
  // purely local): this debounces a call out to OLA Places so a search for
  // a landmark (not necessarily a listed spot) can fly the map there.
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!query.trim()) {
      setPlaceResults([]);
      return;
    }
    searchDebounce.current = setTimeout(async () => {
      const results = await searchPlaces(query, userLocation ? { latitude: userLocation.lat, longitude: userLocation.lon } : undefined);
      setPlaceResults(results);
    }, 400);
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function selectSearchResult(place: PlaceSuggestion) {
    setFlyToCenter((prev) => ({ latitude: place.latitude, longitude: place.longitude, token: (prev?.token ?? 0) + 1 }));
    setQuery(place.name);
    setPlaceResults([]);
  }

  function handleMapLongPress(latitude: number, longitude: number) {
    if (!session) {
      navigation.navigate('SignIn');
      return;
    }
    Alert.alert('Add a listing here?', 'Start adding a cheap-eat spot at this location.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Add listing',
        onPress: () => navigation.navigate('AddListing', { pickedLatitude: latitude, pickedLongitude: longitude }),
      },
    ]);
  }

  function handleContribute() {
    if (authLoading) return; // session status not resolved yet — don't guess "signed out"
    navigation.navigate(session ? 'AddListing' : 'SignIn');
  }

  function handleCityPress() {
    Alert.alert(
      'Choose a city',
      undefined,
      CITIES.map((city) => ({ text: city === 'Bengaluru' ? `${city} ✓` : `${city} (coming soon)` }))
    );
  }

  const filtered = listings.filter((l) => l.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <View style={styles.container}>
      <View style={styles.mapArea}>
        <ListingsMap
          listings={filtered}
          onSelectListing={(listingId) => navigation.navigate('ListingDetail', { listingId })}
          onLongPress={handleMapLongPress}
          flyToCenter={flyToCenter ?? undefined}
        />

        <View style={styles.overlayRow}>
          <Pressable style={styles.cityButton} onPress={handleCityPress}>
            <Text style={styles.cityButtonText}>Bengaluru ▾</Text>
          </Pressable>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search by landmark or restaurant name"
            style={styles.search}
          />
          <Pressable style={styles.contributeButton} onPress={handleContribute}>
            <Text style={styles.contributeButtonText}>+ Contribute</Text>
          </Pressable>
        </View>

        {placeResults.length > 0 ? (
          <FlatList
            data={placeResults}
            keyExtractor={(item) => item.placeId}
            style={styles.resultsList}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable style={styles.resultRow} onPress={() => selectSearchResult(item)}>
                <Text style={styles.resultName}>{item.name}</Text>
                {item.address ? (
                  <Text style={styles.resultAddress} numberOfLines={1}>
                    {item.address}
                  </Text>
                ) : null}
              </Pressable>
            )}
          />
        ) : (
          <View style={styles.longPressHint} pointerEvents="none">
            <Text style={styles.longPressHintText}>Long-press the map to add a spot</Text>
          </View>
        )}
      </View>

      <View style={styles.panel}>
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator
          persistentScrollbar
          ListEmptyComponent={
            !loading ? <Text style={styles.empty}>No listings yet. Be the first to add one.</Text> : null
          }
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => navigation.navigate('ListingDetail', { listingId: item.id })}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{item.name}</Text>
                <Text style={styles.cardPrice}>₹{item.price_rupees}</Text>
              </View>
              {item.note ? (
                <Text style={styles.cardNote} numberOfLines={2}>
                  {item.note}
                </Text>
              ) : null}
              <View style={styles.cardMeta}>
                <Text style={styles.cardMetaText}>▲ {item.voteCount}</Text>
                {item.distanceKm !== null ? (
                  <Text style={styles.cardMetaText}>{item.distanceKm.toFixed(1)} km away</Text>
                ) : null}
              </View>
            </Pressable>
          )}
        />
      </View>
    </View>
  );
}

const PANEL_HEIGHT = 220;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  mapArea: { flex: 1 },
  overlayRow: {
    position: 'absolute',
    top: 50,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cityButton: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  cityButtonText: { fontSize: 13, fontWeight: '600', color: '#333' },
  search: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  contributeButton: {
    backgroundColor: '#ec4899',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  contributeButtonText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  resultsList: {
    position: 'absolute',
    top: 100,
    left: 12,
    right: 12,
    backgroundColor: '#fff',
    borderRadius: 10,
    maxHeight: 260,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  resultRow: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: '#eee' },
  resultName: { fontWeight: '600', fontSize: 14 },
  resultAddress: { color: '#888', fontSize: 12, marginTop: 2 },
  longPressHint: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  longPressHintText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  panel: {
    height: PANEL_HEIGHT,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
  },
  listContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  empty: { textAlign: 'center', color: '#888', marginTop: 24 },
  card: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  cardPrice: { fontSize: 16, fontWeight: '700', color: '#ec4899' },
  cardNote: { color: '#555', marginTop: 4 },
  cardMeta: { flexDirection: 'row', gap: 12, marginTop: 8 },
  cardMetaText: { color: '#888', fontSize: 13 },
});
