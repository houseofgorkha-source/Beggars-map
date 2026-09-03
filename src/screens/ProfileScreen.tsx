import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase, PUBLIC_LISTING_COLUMNS } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { RootStackParamList } from '../navigation/types';
import type { Listing } from '../types/database';

type Nav = NativeStackNavigationProp<RootStackParamList>;

function StoreRow() {
  return (
    <View style={styles.contactRow}>
      <Text style={styles.storeText}>App Store: Coming soon</Text>
      <Text style={styles.storeText}>Play Store: Coming soon</Text>
    </View>
  );
}

// Leaderboard/About/Legal are all reached from here now — none of them are
// primary tabs anymore (see RootNavigator). This mirrors web's own
// About-reachable-from-more-than-one-place pattern rather than being a
// duplication to avoid.
function MenuRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.menuRow} onPress={onPress}>
      <Text style={styles.menuRowText}>{label}</Text>
      <Text style={styles.menuRowChevron}>›</Text>
    </Pressable>
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
      .select(PUBLIC_LISTING_COLUMNS)
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

            <View style={styles.menuSection}>
              <MenuRow label="Leaderboard" onPress={() => navigation.navigate('Leaderboard')} />
              <MenuRow label="About Us" onPress={() => navigation.navigate('About')} />
              <MenuRow label="Privacy Policy & Terms" onPress={() => navigation.navigate('Legal')} />
            </View>

            <StoreRow />
          </View>
        }
      />
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={myListings}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <>
            <View style={styles.accountBlock}>
              <Text style={styles.name}>{profile?.display_name ?? 'Contributor'}</Text>
            </View>
            <Text style={styles.sectionTitle}>My listings ({myListings.length})</Text>
          </>
        }
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
        ListFooterComponent={
          <>
            <Text style={styles.rank}>{rank ? `Rank #${rank}` : 'Not ranked yet'}</Text>

            <View style={styles.menuSection}>
              <MenuRow label="Leaderboard" onPress={() => navigation.navigate('Leaderboard')} />
              <MenuRow label="About Us" onPress={() => navigation.navigate('About')} />
              <MenuRow label="Privacy Policy & Terms" onPress={() => navigation.navigate('Legal')} />
            </View>

            <Pressable style={styles.deleteAccountButton} onPress={confirmDeleteAccount} disabled={deleting}>
              <Text style={styles.deleteAccountText}>{deleting ? 'Deleting…' : 'Delete my account'}</Text>
            </Pressable>
            <Pressable style={styles.signOutButton} onPress={signOut}>
              <Text style={styles.signOutText}>Sign out</Text>
            </Pressable>

            <StoreRow />
          </>
        }
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
  accountBlock: { padding: 16, paddingBottom: 4 },
  name: { fontSize: 20, fontWeight: '700' },
  rank: { color: '#ec4899', fontWeight: '600', paddingHorizontal: 16, marginTop: 20 },
  menuSection: {
    marginTop: 12,
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    overflow: 'hidden',
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f2f2f2',
  },
  menuRowText: { fontSize: 15, fontWeight: '600', color: '#222' },
  menuRowChevron: { color: '#bbb', fontSize: 18 },
  signOutButton: { marginTop: 16, marginHorizontal: 16, alignSelf: 'flex-start' },
  signOutText: { color: '#a33' },
  deleteAccountButton: { marginTop: 20, marginHorizontal: 16, alignSelf: 'flex-start' },
  deleteAccountText: { color: '#a33', fontSize: 13, textDecorationLine: 'underline' },
  sectionTitle: { fontSize: 15, fontWeight: '700', margin: 16, marginBottom: 8 },
  listContent: { paddingBottom: 24 },
  empty: { color: '#888', marginHorizontal: 16 },
  card: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 10,
    padding: 12,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  cardTitle: { fontWeight: '600' },
  cardPrice: { fontWeight: '700', color: '#ec4899' },
  contactRow: { flexDirection: 'row', gap: 16, marginTop: 20, marginHorizontal: 16, marginBottom: 8 },
  storeText: { color: '#888', fontWeight: '600', fontSize: 13 },
});
