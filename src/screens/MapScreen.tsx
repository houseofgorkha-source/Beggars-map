import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  PanGestureHandler,
  State as GestureState,
  type PanGestureHandlerGestureEvent,
  type PanGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase, PUBLIC_LISTING_COLUMNS } from '../lib/supabase';
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

// Mirrors web's mobile-portrait bottom sheet (App.tsx's computeSheetSnaps /
// handleSheetDrag*) — two modes (a small "peek" strip vs. an expanded list),
// snapping to whichever is closer on release unless the gesture reads as a
// deliberate flick. Unlike web, the map itself never resizes here: the sheet
// is a separate absolutely-positioned layer over the map, and RN's touch
// hit-testing is bounded by each view's own layout rect, so there's no
// z-index-swallows-the-drag-handle class of bug to guard against the way
// web's TOP_RESERVE_PX had to.
const PEEK_HEIGHT = 64;
const SHEET_TOP_RESERVE = 96;
const FLING_PX_PER_SEC = 500;

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
  const insets = useSafeAreaInsets();
  const { session, loading: authLoading } = useAuth();
  const [listings, setListings] = useState<ListingWithDistance[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [cityPickerOpen, setCityPickerOpen] = useState(false);

  const [placeResults, setPlaceResults] = useState<PlaceSuggestion[]>([]);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flyToCenter, setFlyToCenter] = useState<{ latitude: number; longitude: number; token: number } | null>(null);

  // Bottom sheet — see the PEEK_HEIGHT/SHEET_TOP_RESERVE comment above.
  const [mapAreaHeight, setMapAreaHeight] = useState(0);
  const [sheetMode, setSheetMode] = useState<'peek' | 'list'>('peek');
  const sheetHeight = useRef(new Animated.Value(PEEK_HEIGHT)).current;
  const sheetHeightValueRef = useRef(PEEK_HEIGHT);
  const dragStartHeightRef = useRef(PEEK_HEIGHT);
  const dragVelocityRef = useRef(0);

  useEffect(() => {
    const id = sheetHeight.addListener(({ value }) => {
      sheetHeightValueRef.current = value;
    });
    return () => sheetHeight.removeListener(id);
  }, [sheetHeight]);

  const listSnapHeight = useMemo(() => {
    if (mapAreaHeight <= 0) return PEEK_HEIGHT + 260;
    return Math.round(
      Math.max(PEEK_HEIGHT + 24, Math.min(mapAreaHeight * 0.86, mapAreaHeight - SHEET_TOP_RESERVE))
    );
  }, [mapAreaHeight]);

  const snapTo = useCallback(
    (mode: 'peek' | 'list') => {
      setSheetMode(mode);
      Animated.spring(sheetHeight, {
        toValue: mode === 'peek' ? PEEK_HEIGHT : listSnapHeight,
        useNativeDriver: false,
        bounciness: 4,
        speed: 14,
      }).start();
    },
    [listSnapHeight, sheetHeight]
  );

  function onSheetGestureEvent(event: PanGestureHandlerGestureEvent) {
    const { translationY, velocityY } = event.nativeEvent;
    dragVelocityRef.current = velocityY;
    // Moving the finger UP (negative translationY) makes the sheet taller —
    // same sign convention as web's `deltaY = startY - clientY`.
    const nextHeight = Math.max(
      PEEK_HEIGHT * 0.85,
      Math.min(listSnapHeight * 1.04, dragStartHeightRef.current - translationY)
    );
    sheetHeight.setValue(nextHeight);
  }

  function onSheetHandlerStateChange(event: PanGestureHandlerStateChangeEvent) {
    const { state, oldState } = event.nativeEvent;
    if (state === GestureState.BEGAN) {
      dragStartHeightRef.current = sheetHeightValueRef.current;
      dragVelocityRef.current = 0;
      return;
    }
    if (oldState === GestureState.ACTIVE && (state === GestureState.END || state === GestureState.CANCELLED)) {
      const released = sheetHeightValueRef.current;
      const midpoint = (PEEK_HEIGHT + listSnapHeight) / 2;
      const next: 'peek' | 'list' =
        Math.abs(dragVelocityRef.current) > FLING_PX_PER_SEC
          ? dragVelocityRef.current < 0
            ? 'list'
            : 'peek'
          : released > midpoint
            ? 'list'
            : 'peek';
      snapTo(next);
    }
  }

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
    const { data, error } = await supabase
      .from('listings')
      .select(`${PUBLIC_LISTING_COLUMNS}, votes(count)`)
      .order('price_rupees', { ascending: true });

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

  function handleAddPress() {
    if (authLoading) return; // session status not resolved yet — don't guess "signed out"
    navigation.navigate(session ? 'AddListing' : 'SignIn');
  }

  function handleCityPress() {
    setCityPickerOpen(true);
  }

  const filtered = listings.filter((l) => l.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View>
          <Text style={styles.brand}>Beggars Map</Text>
          <Text style={styles.brandSub}>Affordable eats in Bengaluru, ₹100 or under</Text>
        </View>
        <Pressable style={styles.aboutButton} onPress={() => navigation.navigate('About')}>
          <Text style={styles.aboutButtonText}>About Us</Text>
        </Pressable>
      </View>

      <View style={styles.mapArea} onLayout={(e) => setMapAreaHeight(e.nativeEvent.layout.height)}>
        <ListingsMap
          listings={filtered}
          onSelectListing={(listingId) => navigation.navigate('ListingDetail', { listingId })}
          onLongPress={handleMapLongPress}
          flyToCenter={flyToCenter ?? undefined}
        />

        <View style={styles.overlayRow}>
          <View style={styles.searchBar}>
            <Pressable style={styles.citySelect} onPress={handleCityPress}>
              <Text style={styles.citySelectText}>Bengaluru ▾</Text>
            </Pressable>
            <View style={styles.searchDivider} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search dish, area, landmark, or restaurant"
              placeholderTextColor="#999"
              style={styles.searchInput}
            />
          </View>
          <Pressable style={styles.addButton} onPress={handleAddPress}>
            <Text style={styles.addButtonText}>+ Add</Text>
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
          <View style={[styles.longPressHint, { bottom: PEEK_HEIGHT + 16 }]} pointerEvents="none">
            <Text style={styles.longPressHintText}>Long-press the map to add a spot</Text>
          </View>
        )}

        <Animated.View style={[styles.sheet, { height: sheetHeight }]}>
          <PanGestureHandler
            onGestureEvent={onSheetGestureEvent}
            onHandlerStateChange={onSheetHandlerStateChange}
            hitSlop={{ top: 12, bottom: 12 }}
          >
            <Animated.View style={styles.dragHandleWrap}>
              <View style={styles.dragHandleBar} />
              <Pressable onPress={() => snapTo(sheetMode === 'peek' ? 'list' : 'peek')} hitSlop={8}>
                <Text style={styles.peekHint}>
                  {sheetMode === 'peek' ? 'Swipe up to browse restaurants ▲' : 'Swipe down for the map ▼'}
                </Text>
              </Pressable>
            </Animated.View>
          </PanGestureHandler>

          <FlatList
            data={filtered}
            keyExtractor={(item) => item.id}
            refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator
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
        </Animated.View>
      </View>

      <Modal
        visible={cityPickerOpen}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setCityPickerOpen(false)}
      >
        <Pressable style={styles.cityModalBackdrop} onPress={() => setCityPickerOpen(false)}>
          <Pressable style={styles.cityModalCard} onPress={() => {}}>
            <Text style={styles.cityModalTitle}>Choose a city</Text>
            {CITIES.map((city) => {
              const isBengaluru = city === 'Bengaluru';
              return (
                <Pressable
                  key={city}
                  style={styles.cityModalRow}
                  onPress={() => setCityPickerOpen(false)}
                  disabled={!isBengaluru}
                >
                  <Text style={[styles.cityModalRowText, isBengaluru && styles.cityModalRowTextActive]}>
                    {city}
                  </Text>
                  <Text style={styles.cityModalRowStatus}>{isBengaluru ? '✓' : 'Coming soon'}</Text>
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    gap: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  brand: { fontSize: 16, fontWeight: '900', color: '#ec4899', letterSpacing: -0.3 },
  brandSub: { fontSize: 11, color: '#888', marginTop: 2 },
  aboutButton: {
    borderWidth: 1,
    borderColor: '#ddd',
    backgroundColor: '#fff',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  aboutButtonText: { fontSize: 12, fontWeight: '600', color: '#ec4899' },
  mapArea: { flex: 1 },
  overlayRow: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  citySelect: { paddingLeft: 16, paddingRight: 8, paddingVertical: 14 },
  citySelectText: { fontSize: 14, fontWeight: '600', color: '#333' },
  searchDivider: { width: 1, alignSelf: 'stretch', marginVertical: 10, backgroundColor: '#eee' },
  searchInput: { flex: 1, paddingVertical: 14, paddingHorizontal: 10, fontSize: 14, color: '#0a0a0a' },
  addButton: {
    alignSelf: 'flex-end',
    backgroundColor: '#ec4899',
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  addButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  resultsList: {
    position: 'absolute',
    top: 114,
    left: 12,
    right: 12,
    backgroundColor: '#fff',
    borderRadius: 10,
    maxHeight: 260,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  resultRow: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: '#eee' },
  resultName: { fontWeight: '600', fontSize: 14 },
  resultAddress: { color: '#888', fontSize: 12, marginTop: 2 },
  longPressHint: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  longPressHintText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
  },
  dragHandleWrap: { alignItems: 'center', paddingTop: 10, paddingBottom: 10 },
  dragHandleBar: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#ddd', marginBottom: 8 },
  peekHint: { fontSize: 12, fontWeight: '600', color: '#999' },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  empty: { textAlign: 'center', color: '#888', marginTop: 24 },
  card: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  cardPrice: { fontSize: 16, fontWeight: '700', color: '#ec4899' },
  cardNote: { color: '#555', marginTop: 4 },
  cardMeta: { flexDirection: 'row', gap: 12, marginTop: 8 },
  cardMetaText: { color: '#888', fontSize: 13 },
  cityModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  cityModalCard: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  cityModalTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0a0a0a',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 8,
  },
  cityModalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderTopWidth: 1,
    borderTopColor: '#f2f2f2',
  },
  cityModalRowText: { fontSize: 15, fontWeight: '600', color: '#bbb' },
  cityModalRowTextActive: { color: '#0a0a0a' },
  cityModalRowStatus: { fontSize: 13, fontWeight: '600', color: '#ec4899' },
});
