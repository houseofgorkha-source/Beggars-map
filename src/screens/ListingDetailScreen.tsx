import { useCallback, useState } from 'react';
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
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { RootStackParamList } from '../navigation/types';
import type { Listing, Review } from '../types/database';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type ListingRoute = RouteProp<RootStackParamList, 'ListingDetail'>;

const REPORT_REASONS = ['Closed / doesn\'t exist', 'Wrong price', 'Inappropriate photo', 'Spam or duplicate'];

export default function ListingDetailScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<ListingRoute>();
  const { session } = useAuth();

  const [listing, setListing] = useState<Listing | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [voteCount, setVoteCount] = useState(0);
  const [hasVoted, setHasVoted] = useState(false);
  const [comment, setComment] = useState('');

  const load = useCallback(async () => {
    const { data: listingData } = await supabase
      .from('listings')
      .select('*')
      .eq('id', params.listingId)
      .single();
    setListing(listingData as Listing);

    const { data: reviewData } = await supabase
      .from('reviews')
      .select('*')
      .eq('listing_id', params.listingId)
      .order('created_at', { ascending: false });
    setReviews((reviewData as Review[]) ?? []);

    const { count } = await supabase
      .from('votes')
      .select('*', { count: 'exact', head: true })
      .eq('listing_id', params.listingId);
    setVoteCount(count ?? 0);

    if (session) {
      const { data: myVote } = await supabase
        .from('votes')
        .select('listing_id')
        .eq('listing_id', params.listingId)
        .eq('created_by', session.user.id)
        .maybeSingle();
      setHasVoted(!!myVote);
    }
  }, [params.listingId, session]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

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

  async function submitReview(worthIt: boolean) {
    if (!session) {
      navigation.navigate('SignIn');
      return;
    }
    const { error } = await supabase.from('reviews').upsert(
      {
        listing_id: params.listingId,
        created_by: session.user.id,
        comment: comment.trim() || null,
        worth_it: worthIt,
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
          await supabase.from('reports').insert({
            listing_id: params.listingId,
            reported_by: session.user.id,
            reason,
          });
          Alert.alert('Thanks', 'We\'ll take a look.');
        },
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }

  if (!listing) {
    return (
      <View style={styles.container}>
        <Text style={styles.loading}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {listing.photo_url ? <Image source={{ uri: listing.photo_url }} style={styles.photo} /> : null}

      <View style={styles.headerRow}>
        <Text style={styles.title}>{listing.name}</Text>
        <Text style={styles.price}>₹{listing.price_rupees}</Text>
      </View>

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

      <Text style={styles.sectionTitle}>Reviews ({reviews.length})</Text>

      <View style={styles.reviewForm}>
        <TextInput
          style={styles.reviewInput}
          value={comment}
          onChangeText={setComment}
          placeholder="Add a comment (optional)"
        />
        <View style={styles.reviewButtons}>
          <Pressable style={styles.reviewYes} onPress={() => submitReview(true)}>
            <Text style={styles.reviewButtonText}>Worth it</Text>
          </Pressable>
          <Pressable style={styles.reviewNo} onPress={() => submitReview(false)}>
            <Text style={styles.reviewButtonText}>Not worth it</Text>
          </Pressable>
        </View>
      </View>

      {reviews.map((review) => (
        <View key={review.id} style={styles.reviewCard}>
          <Text style={styles.reviewVerdict}>{review.worth_it ? '👍 Worth it' : '👎 Not worth it'}</Text>
          {review.comment ? <Text style={styles.reviewComment}>{review.comment}</Text> : null}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 48 },
  loading: { textAlign: 'center', marginTop: 48, color: '#888' },
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
  sectionTitle: { fontSize: 16, fontWeight: '700', marginTop: 28, marginBottom: 10 },
  reviewForm: { marginBottom: 16 },
  reviewInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 8,
  },
  reviewButtons: { flexDirection: 'row', gap: 10 },
  reviewYes: { flex: 1, backgroundColor: '#0a7d3c', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  reviewNo: { flex: 1, backgroundColor: '#a33', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  reviewButtonText: { color: '#fff', fontWeight: '600' },
  reviewCard: { borderTopWidth: 1, borderTopColor: '#eee', paddingVertical: 10 },
  reviewVerdict: { fontWeight: '600' },
  reviewComment: { color: '#555', marginTop: 4 },
});
