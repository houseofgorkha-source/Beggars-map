import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { Camera, Map, Marker } from '@maplibre/maplibre-react-native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { vectorStyleUrl, boundsForPoints } from '../lib/olaMaps';
import { reverseGeocode } from '../lib/geocoding';
import { StarRatingInput, StarRatingDisplay } from '../components/StarRating';
import type { RootStackParamList } from '../navigation/types';
import type { Listing, ListingRating, Review } from '../types/database';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type ListingRoute = RouteProp<RootStackParamList, 'ListingDetail'>;

const REPORT_REASONS = ['Closed / doesn\'t exist', 'Wrong price', 'Inappropriate photo', 'Spam or duplicate'];

export default function ListingDetailScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<ListingRoute>();
  const { session } = useAuth();

  const [listing, setListing] = useState<Listing | null>(null);
  const [rating, setRating] = useState<ListingRating | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [voteCount, setVoteCount] = useState(0);
  const [hasVoted, setHasVoted] = useState(false);
  const [comment, setComment] = useState('');
  const [foodQuality, setFoodQuality] = useState(5);
  const [hygiene, setHygiene] = useState(5);
  const [availability, setAvailability] = useState(5);
  const [maintenance, setMaintenance] = useState(5);
  const [address, setAddress] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    // None of these depend on each other's results, so run them concurrently
    // instead of one round-trip after another.
    const [{ data: listingData, error: listingError }, { data: ratingData }, { data: reviewData }, { count }, myVoteResult] =
      await Promise.all([
        supabase.from('listings').select('*').eq('id', params.listingId).maybeSingle(),
        supabase.from('listing_ratings').select('*').eq('listing_id', params.listingId).maybeSingle(),
        supabase.from('reviews').select('*').eq('listing_id', params.listingId).order('created_at', { ascending: false }),
        supabase.from('votes').select('*', { count: 'exact', head: true }).eq('listing_id', params.listingId),
        session
          ? supabase
              .from('votes')
              .select('listing_id')
              .eq('listing_id', params.listingId)
              .eq('created_by', session.user.id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

    // A listing that's been deleted, or hidden by moderation (RLS filters it
    // out of public SELECT), comes back as no row rather than an error —
    // .maybeSingle() (not .single()) is what makes that "no row" case land
    // here as null instead of throwing, so we can tell it apart from "still
    // fetching" and show a real message instead of spinning forever.
    if (listingError || !listingData) {
      setNotFound(true);
      return;
    }

    setListing(listingData as Listing);
    setRating(ratingData as ListingRating | null);
    setReviews((reviewData as Review[]) ?? []);
    setVoteCount(count ?? 0);
    setHasVoted(!!myVoteResult.data);
  }, [params.listingId, session]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useEffect(() => {
    if (!listing) return;
    let cancelled = false;
    setAddress(null);
    reverseGeocode(listing.latitude, listing.longitude).then((result) => {
      if (!cancelled) setAddress(result);
    });
    return () => {
      cancelled = true;
    };
  }, [listing?.id]);

  async function toggleVote() {
    if (!session) {
      navigation.navigate('SignIn');
      return;
    }
    if (hasVoted) {
      await supabase.from('votes').delete().eq('listing_id', params.listingId).eq('created_by', session.user.id);
    } else {
      await supabase.from('votes').insert({ listing_id: params.listingId, created_by: session.user.id });
    }
    load();
  }

  async function submitReview() {
    if (!session) {
      navigation.navigate('SignIn');
      return;
    }
    const { error } = await supabase.from('reviews').upsert(
      {
        listing_id: params.listingId,
        created_by: session.user.id,
        comment: comment.trim() || null,
        food_quality: foodQuality,
        hygiene,
        availability,
        maintenance,
      },
      { onConflict: 'listing_id,created_by' }
    );
    if (error) {
      Alert.alert('Could not save review', error.message);
      return;
    }
    setComment('');
    load();
  }

  async function openDirections() {
    if (!listing) return;
    const label = encodeURIComponent(listing.name);
    const appUrl = Platform.select({
      ios: `maps://?daddr=${listing.latitude},${listing.longitude}&q=${label}`,
      android: `google.navigation:q=${listing.latitude},${listing.longitude}`,
    });
    const webUrl = `https://www.google.com/maps/dir/?api=1&destination=${listing.latitude},${listing.longitude}`;

    if (appUrl && (await Linking.canOpenURL(appUrl))) {
      Linking.openURL(appUrl);
    } else {
      Linking.openURL(webUrl);
    }
  }

  function reportListing() {
    if (!session) {
      navigation.navigate('SignIn');
      return;
    }
    Alert.alert('Report this listing', 'Why are you reporting it?', [
      ...REPORT_REASONS.map((reason) => ({
        text: reason,
        onPress: async () => {
          const { error } = await supabase.from('reports').insert({
            listing_id: params.listingId,
            reported_by: session.user.id,
            reason,
          });
          if (error?.code === '23505') {
            Alert.alert('Already reported', 'You already reported this listing for that reason.');
            return;
          }
          Alert.alert('Thanks', 'We\'ll take a look.');
        },
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }

  function confirmDeleteListing() {
    Alert.alert('Delete this listing?', 'This removes it for everyone. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: deleteListing },
    ]);
  }

  async function deleteListing() {
    if (!listing) return;
    const { error } = await supabase.from('listings').delete().eq('id', listing.id);
    if (error) {
      Alert.alert('Could not delete listing', error.message);
      return;
    }
    if (listing.photo_url) {
      const path = listing.photo_url.split('/listing-photos/')[1];
      if (path) await supabase.storage.from('listing-photos').remove([path]);
    }
    navigation.goBack();
  }

  function confirmDeleteReview(reviewId: string) {
    Alert.alert('Delete your review?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteReview(reviewId) },
    ]);
  }

  async function deleteReview(reviewId: string) {
    const { error } = await supabase.from('reviews').delete().eq('id', reviewId);
    if (error) {
      Alert.alert('Could not delete review', error.message);
      return;
    }
    load();
  }

  if (notFound) {
    return (
      <View style={styles.container}>
        <Text style={styles.loading}>This listing is no longer available.</Text>
      </View>
    );
  }

  if (!listing) {
    return (
      <View style={styles.container}>
        <Text style={styles.loading}>Loading…</Text>
      </View>
    );
  }

  const styleUrl = vectorStyleUrl();
  const bounds = boundsForPoints([{ latitude: listing.latitude, longitude: listing.longitude }]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {styleUrl ? (
        <View style={styles.miniMapWrap}>
          <Map style={styles.miniMap} mapStyle={styleUrl}>
            <Camera
              initialViewState={
                bounds
                  ? { bounds, padding: { left: 30, right: 30, top: 30, bottom: 30 } }
                  : { center: [listing.longitude, listing.latitude], zoom: 14 }
              }
            />
            <Marker lngLat={[listing.longitude, listing.latitude]} anchor="bottom">
              <View style={styles.miniMapPin}>
                <Text style={styles.miniMapPinText}>₹{listing.price_rupees}</Text>
              </View>
            </Marker>
          </Map>
          <View style={styles.mapInfoCard}>
            {listing.photo_url ? <Image source={{ uri: listing.photo_url }} style={styles.mapInfoThumb} /> : null}
            <View style={styles.mapInfoText}>
              <StarRatingDisplay rating={rating?.avg_rating ?? null} count={rating?.rating_count ?? 0} size={12} />
              <Text style={styles.mapInfoAddress} numberOfLines={2}>
                {address ?? `${listing.latitude.toFixed(5)}, ${listing.longitude.toFixed(5)}`}
              </Text>
            </View>
          </View>
        </View>
      ) : null}

      {listing.photo_url ? <Image source={{ uri: listing.photo_url }} style={styles.photo} /> : null}

      <View style={styles.headerRow}>
        <Text style={styles.title}>{listing.name}</Text>
        <Text style={styles.price}>₹{listing.price_rupees}</Text>
      </View>

      <StarRatingDisplay rating={rating?.avg_rating ?? null} count={rating?.rating_count ?? 0} size={16} />

      {listing.note ? <Text style={styles.note}>{listing.note}</Text> : null}

      <View style={styles.actionsRow}>
        <Pressable style={[styles.voteButton, hasVoted && styles.voteButtonActive]} onPress={toggleVote}>
          <Text style={[styles.voteButtonText, hasVoted && styles.voteButtonTextActive]}>
            ▲ Worth it ({voteCount})
          </Text>
        </Pressable>
        <Pressable style={styles.directionsButton} onPress={openDirections}>
          <Text style={styles.directionsButtonText}>Directions</Text>
        </Pressable>
        <Pressable style={styles.reportButton} onPress={reportListing}>
          <Text style={styles.reportButtonText}>Report</Text>
        </Pressable>
      </View>

      {session && listing.created_by === session.user.id ? (
        <Pressable style={styles.deleteListingButton} onPress={confirmDeleteListing}>
          <Text style={styles.deleteListingButtonText}>Delete my listing</Text>
        </Pressable>
      ) : null}

      <Text style={styles.sectionTitle}>Reviews ({reviews.length})</Text>

      <View style={styles.reviewForm}>
        <StarRatingInput label="Food quality" value={foodQuality} onChange={setFoodQuality} />
        <StarRatingInput label="Hygiene" value={hygiene} onChange={setHygiene} />
        <StarRatingInput label="Availability" value={availability} onChange={setAvailability} />
        <StarRatingInput label="Maintenance" value={maintenance} onChange={setMaintenance} />
        <TextInput
          style={styles.reviewInput}
          value={comment}
          onChangeText={setComment}
          placeholder="Add a comment (optional)"
        />
        <Pressable style={styles.reviewSubmit} onPress={submitReview}>
          <Text style={styles.reviewSubmitText}>Submit review</Text>
        </Pressable>
      </View>

      {reviews.map((review) => {
        const reviewAvg = (review.food_quality + review.hygiene + review.availability + review.maintenance) / 4;
        return (
          <View key={review.id} style={styles.reviewCard}>
            <StarRatingDisplay rating={reviewAvg} count={1} size={13} />
            {review.comment ? <Text style={styles.reviewComment}>{review.comment}</Text> : null}
            {session && review.created_by === session.user.id ? (
              <Pressable onPress={() => confirmDeleteReview(review.id)}>
                <Text style={styles.deleteReviewText}>Delete my review</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 48 },
  loading: { textAlign: 'center', marginTop: 48, color: '#888' },
  miniMapWrap: {
    height: 180,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 16,
    backgroundColor: '#f2f2f2',
  },
  miniMap: { width: '100%', height: '100%' },
  miniMapPin: {
    backgroundColor: '#0a7d3c',
    borderRadius: 14,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 2,
    borderColor: '#fff',
  },
  miniMapPinText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  mapInfoCard: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 10,
    padding: 8,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  mapInfoThumb: { width: 40, height: 40, borderRadius: 6, backgroundColor: '#eee' },
  mapInfoText: { flex: 1 },
  mapInfoAddress: { color: '#555', fontSize: 12, marginTop: 2 },
  photo: { width: '100%', height: 200, borderRadius: 12, marginBottom: 16, backgroundColor: '#f2f2f2' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  title: { fontSize: 22, fontWeight: '700', flexShrink: 1 },
  price: { fontSize: 20, fontWeight: '700', color: '#0a7d3c' },
  note: { color: '#555', marginTop: 8, fontSize: 15 },
  actionsRow: { flexDirection: 'row', gap: 10, marginTop: 18 },
  voteButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#0a7d3c',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  voteButtonActive: { backgroundColor: '#0a7d3c' },
  voteButtonText: { color: '#0a7d3c', fontWeight: '600' },
  voteButtonTextActive: { color: '#fff' },
  directionsButton: {
    borderWidth: 1,
    borderColor: '#0a7d3c',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  directionsButtonText: { color: '#0a7d3c', fontWeight: '600' },
  reportButton: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  reportButtonText: { color: '#a33' },
  deleteListingButton: { marginTop: 12, alignSelf: 'flex-start' },
  deleteListingButtonText: { color: '#a33', fontSize: 13, textDecorationLine: 'underline' },
  deleteReviewText: { color: '#a33', fontSize: 12, marginTop: 6, textDecorationLine: 'underline' },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginTop: 28, marginBottom: 10 },
  reviewForm: {
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    padding: 14,
  },
  reviewInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 4,
    marginBottom: 10,
  },
  reviewSubmit: { backgroundColor: '#0a7d3c', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  reviewSubmitText: { color: '#fff', fontWeight: '700' },
  reviewCard: { borderTopWidth: 1, borderTopColor: '#eee', paddingVertical: 10 },
  reviewComment: { color: '#555', marginTop: 4 },
});
