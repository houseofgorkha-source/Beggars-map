import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { RootStackParamList } from '../navigation/types';
import type { Listing } from '../types/database';

type Nav = NativeStackNavigationProp<RootStackParamList>;

function AboutSection() {
  return (
    <View style={styles.about}>
      <Text style={styles.aboutTitle}>About Us</Text>
      <Text style={styles.aboutBody}>
        <Text style={styles.aboutBold}>Great food, ₹100 or less.</Text>
        {'\n'}A map of Bengaluru’s most affordable eats, built by the people who eat there.
      </Text>
      <Text style={styles.aboutBody}>
        <Text style={styles.aboutBold}>Tastiest. Healthiest. Best value for money.</Text>
        {'\n'}Affordable shouldn’t mean settling for less.
      </Text>
      <Text style={styles.aboutBody}>
        <Text style={styles.aboutBold}>One rule: ₹100.</Text>
        {'\n'}If it costs more, it doesn’t go on the map.
      </Text>
      <Text style={styles.aboutBody}>
        <Text style={styles.aboutBold}>Nothing here is for sale.</Text>
        {'\n'}No ads. No promoted spots. No paying your way to the top.
      </Text>

      <Text style={styles.aboutTitle}>A Message to Our Community</Text>
      <Text style={styles.aboutBody}>
        <Text style={styles.aboutBold}>This map runs on you.</Text>
        {'\n'}Every listing came from someone who took a minute to add it.
      </Text>
      <Text style={styles.aboutBody}>
        <Text style={styles.aboutBold}>Tastiest? Healthiest? Best value for money? Under ₹100?</Text>
        {'\n'}Then it belongs on the map. <Text style={styles.aboutBold}>Add it.</Text>
      </Text>
      <Text style={styles.aboutBody}>
        <Text style={styles.aboutBold}>Found a ₹60 breakfast? An ₹80 thali?</Text>
        {'\n'}Put it on the map. It takes a minute.
      </Text>
      <Text style={styles.aboutBody}>
        <Text style={styles.aboutBold}>Prices change. Places close.</Text>
        {'\n'}If something is out of date, fix it. That’s what keeps this useful for everyone.
      </Text>
      <Text style={styles.aboutBody}>
        <Text style={styles.aboutBold}>You don’t need to be a critic.</Text>
        {'\n'}Just know good value when you find it.
      </Text>

      <Text style={styles.aboutTagline}>Found by the community. Kept true by the community.</Text>
      <Text style={styles.comingSoon}>Launching soon in Delhi, Mumbai, Kolkata, Chennai, Guwahati and more</Text>
    </View>
  );
}

function StoreRow() {
  return (
    <View style={styles.contactRow}>
      <Text style={styles.storeText}>App Store: Coming soon</Text>
      <Text style={styles.storeText}>Play Store: Coming soon</Text>
    </View>
  );
}

export default function ProfileScreen() {
  const navigation = useNavigation<Nav>();
  const { session, profile, signOut } = useAuth();
  const [myListings, setMyListings] = useState<Listing[]>([]);
  const [rank, setRank] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  function confirmDeleteAccount() {
    Alert.alert(
      'Delete your account?',
      'This permanently deletes your account, your listings, reviews, and votes. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete account', style: 'destructive', onPress: deleteAccount },
      ]
    );
  }

  async function deleteAccount() {
    setDeleting(true);
    const { error } = await supabase.functions.invoke('delete-account');
    setDeleting(false);
    if (error) {
      Alert.alert('Could not delete account', error.message);
      return;
    }
    await signOut();
  }

  const load = useCallback(async () => {
    if (!session) return;

    const { data: listings } = await supabase
      .from('listings')
      .select('*')
      .eq('created_by', session.user.id)
      .order('created_at', { ascending: false });
    setMyListings((listings as Listing[]) ?? []);

    const { data: board } = await supabase.from('leaderboard').select('user_id');
    if (board) {
      const idx = board.findIndex((row) => row.user_id === session.user.id);
      setRank(idx >= 0 ? idx + 1 : null);
    }
  }, [session]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (!session) {
    return (
      <FlatList
        data={[]}
        keyExtractor={() => 'x'}
        renderItem={null}
        ListHeaderComponent={
          <View style={styles.signedOut}>
            <Text style={styles.signedOutTitle}>You're browsing anonymously</Text>
            <Pressable style={styles.signInButton} onPress={() => navigation.navigate('SignIn')}>
              <Text style={styles.signInButtonText}>Sign in</Text>
            </Pressable>
            <Pressable style={styles.legalButton} onPress={() => navigation.navigate('Legal')}>
              <Text style={styles.legalButtonText}>Privacy Policy & Terms</Text>
            </Pressable>
            <StoreRow />
            <AboutSection />
          </View>
        }
      />
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.name}>{profile?.display_name ?? 'Contributor'}</Text>
        <Text style={styles.rank}>{rank ? `Rank #${rank}` : 'Not ranked yet'}</Text>
        <Pressable style={styles.signOutButton} onPress={signOut}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
        <Pressable style={styles.deleteAccountButton} onPress={confirmDeleteAccount} disabled={deleting}>
          <Text style={styles.deleteAccountText}>{deleting ? 'Deleting…' : 'Delete my account'}</Text>
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Legal')}>
          <Text style={styles.legalLink}>Privacy Policy & Terms</Text>
        </Pressable>
        <StoreRow />
      </View>

      <Text style={styles.sectionTitle}>My listings ({myListings.length})</Text>
      <FlatList
        data={myListings}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={<Text style={styles.empty}>You haven't posted anything yet.</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            onPress={() => navigation.navigate('ListingDetail', { listingId: item.id })}
          >
            <Text style={styles.cardTitle}>{item.name}</Text>
            <Text style={styles.cardPrice}>₹{item.price_rupees}</Text>
          </Pressable>
        )}
        ListFooterComponent={<AboutSection />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  signedOut: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  signedOutTitle: { fontSize: 16, color: '#555', marginBottom: 16 },
  signInButton: { backgroundColor: '#ec4899', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 24 },
  signInButtonText: { color: '#fff', fontWeight: '700' },
  legalButton: { marginTop: 16 },
  legalButtonText: { color: '#888', fontSize: 13, textDecorationLine: 'underline' },
  header: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#eee' },
  name: { fontSize: 20, fontWeight: '700' },
  rank: { color: '#ec4899', fontWeight: '600', marginTop: 4 },
  signOutButton: { marginTop: 12, alignSelf: 'flex-start' },
  signOutText: { color: '#a33' },
  deleteAccountButton: { marginTop: 12, alignSelf: 'flex-start' },
  deleteAccountText: { color: '#a33', fontSize: 13, textDecorationLine: 'underline' },
  legalLink: { color: '#888', fontSize: 13, textDecorationLine: 'underline', marginTop: 10 },
  sectionTitle: { fontSize: 15, fontWeight: '700', margin: 16, marginBottom: 8 },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  empty: { color: '#888' },
  card: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  cardTitle: { fontWeight: '600' },
  cardPrice: { fontWeight: '700', color: '#ec4899' },
  contactRow: { flexDirection: 'row', gap: 16, marginTop: 12 },
  storeText: { color: '#888', fontWeight: '600', fontSize: 13 },
  about: { padding: 24, alignItems: 'center' },
  aboutTitle: { fontSize: 24, fontWeight: '900', marginBottom: 12, textAlign: 'center' },
  aboutLead: { fontSize: 16, fontWeight: '600', lineHeight: 23, color: '#333', textAlign: 'center', marginBottom: 12 },
  aboutBody: { fontSize: 14, lineHeight: 21, color: '#555', textAlign: 'center', marginBottom: 10 },
  aboutBold: { color: '#0a0a0a', fontWeight: '700' },
  aboutTagline: { fontSize: 15, fontWeight: '700', color: '#ec4899', textAlign: 'center', marginTop: 6, marginBottom: 4 },
  comingSoon: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: '600',
    color: '#ec4899',
    backgroundColor: '#fce9f2',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    textAlign: 'center',
  },
});
