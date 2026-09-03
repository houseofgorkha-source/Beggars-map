import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { Camera, Map, Marker } from '@maplibre/maplibre-react-native';
import { supabase } from '../lib/supabase';
import { fetchListing, fetchVoteCount, hasUserVoted, toggleVote as toggleVoteRequest, reportListing as reportListingRequest, deleteListing as deleteListingRequest } from '../lib/listings';
import { useAuth } from '../lib/auth';
import { vectorStyleUrl, boundsForPoints } from '../lib/olaMaps';
import { reverseGeocode } from '../lib/geocoding';
import type { RootStackParamList } from '../navigation/types';
import type { Listing } from '../types/database';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type ListingRoute = RouteProp<RootStackParamList, 'ListingDetail'>;

const REPORT_REASONS = ['Closed / doesn\'t exist', 'Wrong price', 'Inappropriate photo', 'Spam or duplicate'];

export default function ListingDetailScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<ListingRoute>();
  const { session } = useAuth();

  const [listing, setListing] = useState<Listing | null>(null);
  const [voteCount, setVoteCount] = useState(0);
  const [hasVoted, setHasVoted] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    // None of these depend on each other's results, so run them concurrently
    // instead of one round-trip after another.
    const [listingResult, voteCount, voted] = await Promise.all([
      fetchListing(params.listingId),
      fetchVoteCount(params.listingId),
      session ? hasUserVoted(params.listingId, session.user.id) : Promise.resolve(false),
    ]);

    // A listing that's been deleted, or hidden by moderation (RLS filters it
    // out of public SELECT), comes back as no row rather than an error —
    // fetchListing's `notFound` case is what makes that land here as null
    // instead of throwing, so we can tell it apart from "still fetching"
    // and show a real message instead of spinning forever.
    if ('error' in listingResult || !listingResult.data) {
      setNotFound(true);
      return;
    }

    setListing(listingResult.data);
    setVoteCount(voteCount);
    setHasVoted(voted);
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
    await toggleVoteRequest(params.listingId, session.user.id, hasVoted);
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
          const result = await reportListingRequest(params.listingId, session.user.id, reason);
          if ('error' in result && result.duplicate) {
            Alert.alert('Already reported', result.error);
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
    const result = await deleteListingRequest(listing.id);
    if ('error' in result) {
      Alert.alert('Could not delete listing', result.error);
      return;
    }
    if (listing.photo_url) {
      const path = listing.photo_url.split('/listing-photos/')[1];
      if (path) await supabase.storage.from('listing-photos').remove([path]);
    }
    navigation.goBack();
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
    backgroundColor: '#ec4899',
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
  price: { fontSize: 20, fontWeight: '700', color: '#ec4899' },
  note: { color: '#555', marginTop: 8, fontSize: 15 },
  actionsRow: { flexDirection: 'row', gap: 10, marginTop: 18 },
  voteButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ec4899',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  voteButtonActive: { backgroundColor: '#ec4899' },
  voteButtonText: { color: '#ec4899', fontWeight: '600' },
  voteButtonTextActive: { color: '#fff' },
  directionsButton: {
    borderWidth: 1,
    borderColor: '#ec4899',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  directionsButtonText: { color: '#ec4899', fontWeight: '600' },
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
});
