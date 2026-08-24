import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { searchPlaces, type PlaceSuggestion } from '../lib/olaMaps';
import { parseGoogleMapsUrl } from '../lib/googleMapsLink';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type AddListingRoute = RouteProp<RootStackParamList, 'AddListing'>;

export default function AddListingScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<AddListingRoute>();
  const { session } = useAuth();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [placeQuery, setPlaceQuery] = useState('');
  const [placeResults, setPlaceResults] = useState<PlaceSuggestion[]>([]);
  const [searchingPlaces, setSearchingPlaces] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [mapsLink, setMapsLink] = useState('');
  const [parsingLink, setParsingLink] = useState(false);

  // Picked-on-map location comes back as route params — apply it once, then clear.
  useFocusEffect(
    useCallback(() => {
      if (params?.pickedLatitude != null && params?.pickedLongitude != null) {
        setCoords({ lat: params.pickedLatitude, lon: params.pickedLongitude });
        navigation.setParams({ pickedLatitude: undefined, pickedLongitude: undefined });
      }
    }, [params?.pickedLatitude, params?.pickedLongitude, navigation])
  );

  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!placeQuery.trim()) {
      setPlaceResults([]);
      return;
    }
    searchDebounce.current = setTimeout(async () => {
      setSearchingPlaces(true);
      const results = await searchPlaces(
        placeQuery,
        coords ? { latitude: coords.lat, longitude: coords.lon } : undefined
      );
      setPlaceResults(results);
      setSearchingPlaces(false);
    }, 400);
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, [placeQuery]);

  function selectPlace(place: PlaceSuggestion) {
    setCoords({ lat: place.latitude, lon: place.longitude });
    if (!name.trim()) setName(place.name);
    setPlaceQuery('');
    setPlaceResults([]);
  }

  async function useCurrentLocation() {
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Location permission needed', 'Enable location to drop a pin at your spot.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
    } finally {
      setLocating(false);
    }
  }

  function pickOnMap() {
    navigation.navigate('PickLocation', {
      initialLatitude: coords?.lat,
      initialLongitude: coords?.lon,
    });
  }

  async function useMapsLink() {
    if (!mapsLink.trim()) return;
    setParsingLink(true);
    try {
      const parsed = await parseGoogleMapsUrl(mapsLink);
      if (!parsed) {
        Alert.alert('Could not read that link', 'Try pasting the full Google Maps share link, or use another location option.');
        return;
      }
      setCoords({ lat: parsed.latitude, lon: parsed.longitude });
      setMapsLink('');
    } finally {
      setParsingLink(false);
    }
  }

  async function pickPhoto() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.6,
    });
    if (!result.canceled && result.assets[0]) {
      setPhotoUri(result.assets[0].uri);
    }
  }

  async function uploadPhoto(userId: string): Promise<string | null> {
    if (!photoUri) return null;
    const response = await fetch(photoUri);
    const blob = await response.arrayBuffer();
    const ext = photoUri.split('.').pop() ?? 'jpg';
    const path = `${userId}/${Date.now()}.${ext}`;

    const { error } = await supabase.storage.from('listing-photos').upload(path, blob, {
      contentType: `image/${ext}`,
    });
    if (error) return null;

    const { data } = supabase.storage.from('listing-photos').getPublicUrl(path);
    return data.publicUrl;
  }

  async function submit() {
    if (!session) return;
    const priceNumber = Number(price);

    if (!name.trim()) {
      Alert.alert('Name required', 'Give this spot a name.');
      return;
    }
    if (!priceNumber || priceNumber <= 0) {
      Alert.alert('Price required', 'Enter what a plate/meal costs there.');
      return;
    }
    if (!coords) {
      Alert.alert('Location required', 'Set a location using one of the options above.');
      return;
    }

    setSubmitting(true);
    try {
      const photoUrl = await uploadPhoto(session.user.id);

      const { error } = await supabase.from('listings').insert({
        created_by: session.user.id,
        name: name.trim(),
        price_rupees: priceNumber,
        note: note.trim() || null,
        photo_url: photoUrl,
        latitude: coords.lat,
        longitude: coords.lon,
      });

      if (error) {
        Alert.alert('Could not save listing', error.message);
        return;
      }

      navigation.goBack();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Name</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. Amma's Idli Corner" />

      <Text style={styles.label}>Price (₹ per plate/meal)</Text>
      <TextInput
        style={styles.input}
        value={price}
        onChangeText={setPrice}
        placeholder="30"
        keyboardType="number-pad"
      />

      <Text style={styles.label}>Note (optional)</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={note}
        onChangeText={setNote}
        placeholder="What's good here, timing, anything to know"
        multiline
      />

      <Text style={styles.label}>Photo (optional)</Text>
      <Pressable style={styles.photoButton} onPress={pickPhoto}>
        {photoUri ? (
          <Image source={{ uri: photoUri }} style={styles.photoPreview} />
        ) : (
          <Text style={styles.photoButtonText}>Choose a photo</Text>
        )}
      </Pressable>

      <Text style={styles.label}>Location</Text>
      {coords ? (
        <View style={styles.pinnedBanner}>
          <Text style={styles.pinnedBannerText}>Pinned ✓ ({coords.lat.toFixed(4)}, {coords.lon.toFixed(4)})</Text>
        </View>
      ) : null}

      <View style={styles.locationRow}>
        <Pressable style={styles.locationButton} onPress={useCurrentLocation} disabled={locating}>
          <Text style={styles.locationButtonText}>{locating ? 'Locating…' : 'Current location'}</Text>
        </Pressable>
        <Pressable style={styles.locationButton} onPress={pickOnMap}>
          <Text style={styles.locationButtonText}>Pick on map</Text>
        </Pressable>
      </View>

      <Text style={styles.sublabel}>Search by name</Text>
      <TextInput
        style={styles.input}
        value={placeQuery}
        onChangeText={setPlaceQuery}
        placeholder="Search for the place on the map"
      />
      {searchingPlaces ? <ActivityIndicator style={styles.searchSpinner} /> : null}
      {placeResults.length > 0 ? (
        <FlatList
          data={placeResults}
          keyExtractor={(item) => item.placeId}
          style={styles.resultsList}
          scrollEnabled={false}
          renderItem={({ item }) => (
            <Pressable style={styles.resultRow} onPress={() => selectPlace(item)}>
              <Text style={styles.resultName}>{item.name}</Text>
              {item.address ? (
                <Text style={styles.resultAddress} numberOfLines={1}>
                  {item.address}
                </Text>
              ) : null}
            </Pressable>
          )}
        />
      ) : null}

      <Text style={styles.sublabel}>Or paste a Google Maps link</Text>
      <View style={styles.linkRow}>
        <TextInput
          style={[styles.input, styles.linkInput]}
          value={mapsLink}
          onChangeText={setMapsLink}
          placeholder="https://maps.app.goo.gl/..."
          autoCapitalize="none"
        />
        <Pressable style={styles.linkButton} onPress={useMapsLink} disabled={parsingLink}>
          <Text style={styles.linkButtonText}>{parsingLink ? '…' : 'Use'}</Text>
        </Pressable>
      </View>

      <Pressable style={styles.submit} onPress={submit} disabled={submitting}>
        <Text style={styles.submitText}>{submitting ? 'Posting…' : 'Post listing'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 48 },
  label: { fontSize: 13, fontWeight: '600', color: '#555', marginTop: 16, marginBottom: 6 },
  sublabel: { fontSize: 12, color: '#888', marginTop: 14, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  photoButton: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photoButtonText: { color: '#888' },
  photoPreview: { width: '100%', height: '100%' },
  pinnedBanner: {
    backgroundColor: '#eaf6ee',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  pinnedBannerText: { color: '#0a7d3c', fontWeight: '600' },
  locationRow: { flexDirection: 'row', gap: 10 },
  locationButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  locationButtonText: { color: '#333', fontWeight: '600' },
  searchSpinner: { marginTop: 8 },
  resultsList: { borderWidth: 1, borderColor: '#eee', borderRadius: 10, marginTop: 8, overflow: 'hidden' },
  resultRow: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#eee' },
  resultName: { fontWeight: '600' },
  resultAddress: { color: '#888', fontSize: 12, marginTop: 2 },
  linkRow: { flexDirection: 'row', gap: 8 },
  linkInput: { flex: 1 },
  linkButton: {
    backgroundColor: '#0a7d3c',
    borderRadius: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkButtonText: { color: '#fff', fontWeight: '700' },
  submit: {
    backgroundColor: '#0a7d3c',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 28,
  },
  submitText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
