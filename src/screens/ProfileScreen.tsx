import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { RootStackParamList } from '../navigation/types';
import type { Listing } from '../types/database';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function ProfileScreen() {
  const navigation = useNavigation<Nav>();
  const { session, profile, signOut } = useAuth();
  const [myListings, setMyListings] = useState<Listing[]>([]);
  const [rank, setRank] = useState<number | null>(null);

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
      <View style={styles.signedOut}>
        <Text style={styles.signedOutTitle}>You're browsing anonymously</Text>
        <Pressable style={styles.signInButton} onPress={() => navigation.navigate('SignIn')}>
          <Text style={styles.signInButtonText}>Sign in</Text>
        </Pressable>
      </View>
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
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  signedOut: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  signedOutTitle: { fontSize: 16, color: '#555', marginBottom: 16 },
  signInButton: { backgroundColor: '#0a7d3c', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 24 },
  signInButtonText: { color: '#fff', fontWeight: '700' },
  header: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#eee' },
  name: { fontSize: 20, fontWeight: '700' },
  rank: { color: '#0a7d3c', fontWeight: '600', marginTop: 4 },
  signOutButton: { marginTop: 12, alignSelf: 'flex-start' },
  signOutText: { color: '#a33' },
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
  cardPrice: { fontWeight: '700', color: '#0a7d3c' },
});
