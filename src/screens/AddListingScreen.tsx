import { useCallback, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { createListing } from '../lib/listings';
import { useAuth } from '../lib/auth';
import { parseGoogleMapsUrl } from '../lib/googleMapsLink';
import { checkFoodRelevance } from '../lib/contentModeration';
import { validateDishDrafts, MIN_DISH_PRICE, MAX_DISH_PRICE, type DishDraft } from '../lib/dishes';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type AddListingRoute = RouteProp<RootStackParamList, 'AddListing'>;

// Location provenance (Stage 2A, 0015) — how `coords` was actually obtained.
// Unlike web, mobile applies a raw GPS fix directly with no map-confirmation
// step, so 'device_gps' is a genuine, distinct case here (see
// useCurrentLocation below) rather than something the UX never actually
// produces.
type LocationSource = 'user_pin' | 'device_gps' | 'ola' | 'google' | 'unknown';

export default function AddListingScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<AddListingRoute>();
  const { session } = useAuth();
  const [name, setName] = useState('');
  // One Dish + Price pair minimum; "Add more" appends another. The cheapest
  // entry becomes price_rupees at submit time (see lib/dishes.ts) — that
  // column stays the sort key and the ₹100-cap column.
  const [dishDrafts, setDishDrafts] = useState<DishDraft[]>([{ dish: '', price: '' }]);
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locationSource, setLocationSource] = useState<LocationSource>('unknown');
  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Persistent inline message under the Dish + Price fields, not
  // Alert.alert — a popup the user has to dismiss reads as more disruptive
  // than a mistake like a wrong price or a single-item dish name warrants,
  // and unlike the other Alert.alert validations in this form (name,
  // location), the price/single-item rule is one a user might trip on
  // repeatedly while iterating on entries, not a one-off.
  const [dishError, setDishError] = useState<string | null>(null);

  const [mapsLink, setMapsLink] = useState('');
  const [parsingLink, setParsingLink] = useState(false);

  // Picked-on-map location comes back as route params — apply it once, then
  // clear. Covers both PickLocationScreen's own confirm button and
  // MapScreen's long-press-to-add shortcut; both are an explicit human tap on
  // the map, so 'user_pin' is correct for either origin.
  useFocusEffect(
    useCallback(() => {
      if (params?.pickedLatitude != null && params?.pickedLongitude != null) {
        setCoords({ lat: params.pickedLatitude, lon: params.pickedLongitude });
        setLocationSource('user_pin');
        navigation.setParams({ pickedLatitude: undefined, pickedLongitude: undefined });
      }
    }, [params?.pickedLatitude, params?.pickedLongitude, navigation])
  );

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
      // Applied directly with no map-confirmation step — genuinely
      // unconfirmed raw device GPS, unlike web's equivalent flow.
      setLocationSource('device_gps');
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
      setLocationSource(parsed.source);
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

  async function uploadPhoto(userId: string): Promise<{ url: string; path: string } | null> {
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
    return { url: data.publicUrl, path };
  }

  function updateDishDraft(index: number, patch: Partial<DishDraft>) {
    setDishDrafts((drafts) => drafts.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  }

  async function submit() {
    if (!session) return;
    setDishError(null);

    if (!name.trim()) {
      Alert.alert('Name required', 'Give this spot a name.');
      return;
    }
    // Validates every pair — price range (₹30-₹100), that each dish reads
    // as a qualifying complete meal (not a single item), and derives
    // price_rupees from the cheapest entry — shared, unit-tested logic so
    // mobile and web can't disagree about what's valid.
    const dishCheck = validateDishDrafts(dishDrafts);
    if (!dishCheck.ok) {
      setDishError(dishCheck.error);
      return;
    }
    if (!coords) {
      Alert.alert('Location required', 'Set a location using one of the options above.');
      return;
    }
    const foodCheck = checkFoodRelevance(name, note);
    if (!foodCheck.ok) {
      Alert.alert('Food listings only', `Beggars Map is for affordable eats only — this looks like it might be about "${foodCheck.matchedTerm}" instead.`);
      return;
    }

    setSubmitting(true);
    try {
      const photo = await uploadPhoto(session.user.id);

      const result = await createListing({
        created_by: session.user.id,
        name: name.trim(),
        // Derived, not typed in: the cheapest dish. Keeps price_rupees
        // consistent with `dishes` by construction.
        price_rupees: dishCheck.priceRupees,
        dishes: dishCheck.entries,
        rating,
        note: note.trim() || null,
        photo_url: photo?.url ?? null,
        latitude: coords.lat,
        longitude: coords.lon,
        // Stage 2A location provenance (0015) — set at every point above
        // that changes `coords`, never inferred here at submit time.
        location_source: locationSource,
      });

      if ('error' in result) {
        // The listing never got created, so this upload is orphaned — clean
        // it up rather than leaving it in storage forever. Best-effort: if
        // this delete also fails, the original insert error is still what
        // gets shown to the user.
        if (photo) await supabase.storage.from('listing-photos').remove([photo.path]);
        Alert.alert('Could not save listing', result.error);
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

      {dishDrafts.map((draft, index) => (
        <View key={index} style={styles.dishEntry}>
          {/* Only the added rows are removable — the first pair is the one
              the listing can't exist without. Absolutely positioned in the
              corner since it's no longer part of a shared header row with
              the Dish label. */}
          {index > 0 ? (
            <Pressable
              style={styles.dishRemoveButton}
              onPress={() => setDishDrafts((drafts) => drafts.filter((_, i) => i !== index))}
              hitSlop={8}
            >
              <Text style={styles.dishRemove}>✕</Text>
            </Pressable>
          ) : null}
          {/* Two stacked rows (labels, then inputs) rather than one row per
              field — Dish and Price labels can wrap to different heights, so
              splitting labels from inputs guarantees both TextInputs still
              land on the same row regardless. */}
          <View style={styles.dishPriceLabelsRow}>
            <Text style={[styles.label, styles.dishLabel]}>Dish{index === 0 ? ' (at least one required)' : ''}</Text>
            <Text style={[styles.label, styles.priceLabel]}>Price (₹ per plate)*</Text>
          </View>
          <View style={styles.dishPriceRow}>
            <View style={styles.dishField}>
              <TextInput
                style={styles.input}
                value={draft.dish}
                onChangeText={(value) => updateDishDraft(index, { dish: value })}
                placeholder="e.g. Masala Dosa"
              />
            </View>
            <View style={styles.priceField}>
              <TextInput
                style={styles.input}
                value={draft.price}
                onChangeText={(value) => updateDishDraft(index, { price: value })}
                placeholder="60"
                keyboardType="number-pad"
              />
            </View>
          </View>
        </View>
      ))}
      {/* One hint, always trailing the LAST dish row rather than being
          anchored to row 0 specifically — so it moves down (not sandwiched
          between rows) as more rows are added via "+ Add more". Shaped like
          a dishPriceRow itself (empty dish slot, hint in the price slot) so
          it still lines up under the price column. */}
      <View style={styles.dishPriceRow}>
        <View style={styles.dishField} />
        <View style={styles.priceField}>
          <Text style={styles.fieldHint}>*₹{MIN_DISH_PRICE}-₹{MAX_DISH_PRICE}</Text>
        </View>
      </View>
      <Pressable onPress={() => setDishDrafts((drafts) => [...drafts, { dish: '', price: '' }])}>
        <Text style={styles.addMore}>+ Add more</Text>
      </Pressable>
      {/* Persistent inline message, not Alert.alert — stays visible right
          under the fields it's about until the next submit attempt. */}
      {dishError ? <Text style={styles.dishErrorText}>{dishError}</Text> : null}

      <Text style={styles.label}>Rating (optional)</Text>
      <View style={styles.ratingRow}>
        {[1, 2, 3, 4, 5].map((star) => (
          <Pressable
            key={star}
            // Tapping the currently-selected star clears the rating, so an
            // accidental tap isn't permanent on a form with no other way to
            // unset it.
            onPress={() => setRating((current) => (current === star ? null : star))}
            hitSlop={4}
          >
            <Text style={[styles.ratingStar, rating != null && star <= rating ? styles.ratingStarOn : null]}>★</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Review (optional)</Text>
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
  dishEntry: { position: 'relative' },
  dishRemoveButton: { position: 'absolute', top: 2, right: 0, padding: 4 },
  dishRemove: { fontSize: 13, color: '#aaa' },
  // Dish + Price side by side on one row — dish gets most of the width
  // since it's a free-text name, price only ever needs room for 2-3 digits
  // (₹30-100). Two stacked rows (labels, then inputs) rather than one row
  // per field, so the inputs stay aligned even when the two labels wrap to
  // different heights — see the comment at this row's JSX usage.
  dishPriceLabelsRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-end' },
  // The labels row is sized independently from the narrower input row below
  // it (see priceField) — "Price (₹ per plate)*" needs to read on one line,
  // so it gets no flex/width constraint at all (RN's default flexGrow: 0 /
  // flexShrink: 0 already sizes a Text to its own content) rather than being
  // squeezed into the input's ~64-100px column. Dish's label takes whatever
  // space is left (flex: 1) and can still wrap normally.
  dishLabel: { flex: 1, minWidth: 0 },
  priceLabel: {},
  dishPriceRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  dishField: { flex: 3 },
  priceField: { flex: 1, minWidth: 64, maxWidth: 100 },
  fieldHint: { fontSize: 11, color: '#999', marginTop: 4 },
  addMore: { fontSize: 13, fontWeight: '600', color: '#ec4899', marginTop: 10 },
  dishErrorText: { color: '#a33', fontSize: 13, marginTop: 10 },
  ratingRow: { flexDirection: 'row', gap: 2 },
  ratingStar: { fontSize: 26, color: '#ddd', paddingHorizontal: 2 },
  ratingStarOn: { color: '#ec4899' },
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
    backgroundColor: '#fce9f2',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  pinnedBannerText: { color: '#ec4899', fontWeight: '600' },
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
  linkRow: { flexDirection: 'row', gap: 8 },
  linkInput: { flex: 1 },
  linkButton: {
    backgroundColor: '#ec4899',
    borderRadius: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkButtonText: { color: '#fff', fontWeight: '700' },
  submit: {
    backgroundColor: '#ec4899',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 28,
  },
  submitText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
