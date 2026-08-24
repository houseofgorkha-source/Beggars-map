import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { LeaderboardRow } from '../types/database';

export default function LeaderboardScreen() {
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('leaderboard').select('*').limit(50);
    setRows((data as LeaderboardRow[]) ?? []);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.user_id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        contentContainerStyle={styles.content}
        ListEmptyComponent={
          !loading ? <Text style={styles.empty}>No contributors yet.</Text> : null
        }
        renderItem={({ item, index }) => (
          <View style={styles.row}>
            <Text style={styles.rank}>{index + 1}</Text>
            <View style={styles.info}>
              <Text style={styles.name}>{item.display_name}</Text>
              <Text style={styles.meta}>
                {item.listing_count} listing{item.listing_count === 1 ? '' : 's'} · {item.review_count} review
                {item.review_count === 1 ? '' : 's'}
              </Text>
            </View>
            <Text style={styles.score}>{item.score}</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16 },
  empty: { textAlign: 'center', color: '#888', marginTop: 48 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  rank: { width: 32, fontWeight: '700', color: '#888', fontSize: 15 },
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: '600' },
  meta: { color: '#888', fontSize: 13, marginTop: 2 },
  score: { fontWeight: '700', fontSize: 16, color: '#0a7d3c' },
});
