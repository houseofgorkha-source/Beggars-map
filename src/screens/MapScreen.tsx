import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import ListingsMap from '../components/ListingsMap';
import BottomSheet, { type BottomSheetRef } from '../components/BottomSheet';
import { StarRatingDisplay } from '../components/StarRating';
import type { RootStackParamList } from '../navigation/types';
import type { Listing, ListingRating } from '../types/database';

type Nav = NativeStackNavigationProp<RootStackParamList>;

type ListingWithDistance = Listing & {
  distanceKm: number | null;
  voteCount: number;
  avgRating: number | null;
  ratingCount: number;
};

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
  const { height } = useWindowDimensions();
  const sheetRef = useRef<BottomSheetRef>(null);
  const [listings, setListings] = useState<ListingWithDistance[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);

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
    const [{ data, error }, { data: ratingsData }] = await Promise.all([
      supabase.from('listings').select('*, votes(count)').order('price_rupees', { ascending: true }),
      supabase.from('listing_ratings').select('*'),
    ]);

    if (!error && data) {
      const ratingsByListing = new Map((ratingsData as ListingRating[] | null)?.map((r) => [r.listing_id, r]));
      const mapped: ListingWithDistance[] = data.map((row: any) => {
        const rating = ratingsByListing.get(row.id);
        return {
          ...row,
          voteCount: row.votes?.[0]?.count ?? 0,
          avgRating: rating?.avg_rating ?? null,
          ratingCount: rating?.rating_count ?? 0,
          distanceKm: userLocation
            ? distanceKm(userLocation.lat, userLocation.lon, row.latitude, row.longitude)
            : null,
        };
      });
      setListings(mapped);
    }
    setLoading(false);
  }, [userLocation]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const filtered = listings.filter((l) => l.name.toLowerCase().includes(query.toLowerCase()));
  const collapsedHeight = 140;
  const expandedHeight = Math.round(height * 0.72);

  return (
    <View style={styles.container}>
      <ListingsMap
        listings={filtered}
        onSelectListing={(listingId) => navigation.navigate('ListingDetail', { listingId })}
      />

      {sheetExpanded ? (
        <Pressable style={styles.tapOutside} onPress={() => sheetRef.current?.collapse()} />
      ) : null}

      <BottomSheet
        ref={sheetRef}
        collapsedHeight={collapsedHeight}
        expandedHeight={expandedHeight}
        onSnapChange={setSheetExpanded}
      >
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetContent}>
          <View style={styles.header}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              onFocus={() => sheetRef.current?.expand()}
              placeholder="Search cheap eats in Bengaluru"
              style={styles.search}
            />
          </View>

          <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            !loading ? <Text style={styles.empty}>No listings yet. Be the first to add one.</Text> : null
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.card}
              onPress={() => navigation.navigate('ListingDetail', { listingId: item.id })}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{item.name}</Text>
                <Text style={styles.cardPrice}>₹{item.price_rupees}</Text>
              </View>
              <StarRatingDisplay rating={item.avgRating} count={item.ratingCount} size={12} />
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
        </KeyboardAvoidingView>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  sheetContent: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  search: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  listContent: { paddingHorizontal: 16, paddingBottom: 32 },
  empty: { textAlign: 'center', color: '#888', marginTop: 48 },
  card: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  cardPrice: { fontSize: 16, fontWeight: '700', color: '#0a7d3c' },
  cardNote: { color: '#555', marginTop: 4 },
  cardMeta: { flexDirection: 'row', gap: 12, marginTop: 8 },
  cardMetaText: { color: '#888', fontSize: 13 },
  tapOutside: { ...StyleSheet.absoluteFillObject },
});
