import { Pressable, StyleSheet, Text, View } from 'react-native';

type InputProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
};

export function StarRatingInput({ label, value, onChange }: InputProps) {
  return (
    <View style={styles.inputRow}>
      <Text style={styles.inputLabel}>{label}</Text>
      <View style={styles.starsRow}>
        {[1, 2, 3, 4, 5].map((star) => (
          <Pressable key={star} onPress={() => onChange(star)} hitSlop={4}>
            <Text style={[styles.star, star <= value && styles.starFilled]}>★</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

type DisplayProps = {
  rating: number | null;
  count: number;
  size?: number;
};

export function StarRatingDisplay({ rating, count, size = 14 }: DisplayProps) {
  if (rating === null || count === 0) {
    return <Text style={[styles.displayText, { fontSize: size }]}>No ratings yet</Text>;
  }
  return (
    <Text style={[styles.displayText, { fontSize: size }]}>
      ★ {rating.toFixed(1)} ({count})
    </Text>
  );
}

const styles = StyleSheet.create({
  inputRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  inputLabel: { fontSize: 14, color: '#333' },
  starsRow: { flexDirection: 'row', gap: 2 },
  star: { fontSize: 22, color: '#ddd' },
  starFilled: { color: '#f5a623' },
  displayText: { color: '#f5a623', fontWeight: '700' },
});
