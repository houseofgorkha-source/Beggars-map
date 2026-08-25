import { useCallback, useState } from 'react';
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
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
      <Text style={styles.aboutTitle}>About Beggars Map</Text>
      <Text style={styles.aboutLead}>
        A community-driven directory of affordable meals in Bengaluru — every listing capped at ₹100, because a
        good meal shouldn't be a luxury.
      </Text>
      <Text style={styles.aboutBody}>
        When an economy turns hard, it's the people who can least afford it who go hungry first — some lose their
        homes, some skip meals entirely. We believe everyone deserves at least one proper meal a day, and finding
        one shouldn't take a miracle.
      </Text>
      <Text style={styles.aboutBody}>
        That's where you come in. Add the spots you know, and rate the ones you've tried — so the whole community
        knows exactly where ₹100 goes furthest.
      </Text>
      <Text style={styles.aboutBody}>
        We have no partnerships or deals with any vendor or restaurant — every listing here is purely organic,
        added by people like you, not paid for by anyone.
      </Text>
      <Text style={styles.aboutBody}>
        Our founder still insists 1 rupee is 100 paisa. A reminder that every coin counts, and so does every
        listing you add.
      </Text>
      <Text style={styles.comingSoon}>Launching soon in Delhi, Mumbai, Kolkata, Chennai, Guwahati and more</Text>
    </View>
  );
}

function ContactRow() {
  return (
    <View style={styles.contactRow}>
      <Pressable onPress={() => Linking.openURL('tel:+919606002439')}>
        <Text style={styles.contactLink}>Call +91 96060 02439</Text>
      </Pressable>
      <Pressable onPress={() => Linking.openURL('https://wa.me/919606002439')}>
        <Text style={styles.contactLink}>WhatsApp us</Text>
      </Pressable>
    </View>
  );
}

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
            <ContactRow />
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
        <Pressable onPress={() => navigation.navigate('Legal')}>
          <Text style={styles.legalLink}>Privacy Policy & Terms</Text>
        </Pressable>
        <ContactRow />
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
  signInButton: { backgroundColor: '#0a7d3c', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 24 },
  signInButtonText: { color: '#fff', fontWeight: '700' },
  legalButton: { marginTop: 16 },
  legalButtonText: { color: '#888', fontSize: 13, textDecorationLine: 'underline' },
  header: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#eee' },
  name: { fontSize: 20, fontWeight: '700' },
  rank: { color: '#0a7d3c', fontWeight: '600', marginTop: 4 },
  signOutButton: { marginTop: 12, alignSelf: 'flex-start' },
  signOutText: { color: '#a33' },
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
  cardPrice: { fontWeight: '700', color: '#0a7d3c' },
  contactRow: { flexDirection: 'row', gap: 16, marginTop: 12 },
  contactLink: { color: '#0a7d3c', fontWeight: '600', fontSize: 13 },
  about: { padding: 24, alignItems: 'center' },
  aboutTitle: { fontSize: 24, fontWeight: '900', marginBottom: 12, textAlign: 'center' },
  aboutLead: { fontSize: 16, fontWeight: '600', lineHeight: 23, color: '#333', textAlign: 'center', marginBottom: 12 },
  aboutBody: { fontSize: 14, lineHeight: 21, color: '#555', textAlign: 'center', marginBottom: 10 },
  comingSoon: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: '600',
    color: '#0a7d3c',
    backgroundColor: '#eaf6ee',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    textAlign: 'center',
  },
});
