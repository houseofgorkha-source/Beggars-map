import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

type Props = {
  visible: boolean;
  listingName: string;
  review: string;
  rating: number | null;
  onClose: () => void;
};

// Reads a listing's review (listings.note) in full — opened by the "Review"
// link on the mobile list card (MapScreen.tsx) and the listing detail
// screen. Mirrors web's ReviewOverlay.tsx (same content/behavior), but as a
// native RN Modal rather than a DOM portal — this app already has exactly
// this transparent-backdrop-plus-card pattern for the city picker
// (MapScreen.tsx's cityModal*), so this follows that, not a new pattern.
export default function ReviewModal({ visible, listingName, review, rating, onClose }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.head}>
            <Text style={styles.name}>{listingName}</Text>
            {rating != null ? (
              <Text style={styles.rating}>
                {'★'.repeat(rating)}
                {'☆'.repeat(5 - rating)}
              </Text>
            ) : null}
          </View>
          <Text style={styles.reviewText}>{review}</Text>
          <Pressable style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeButtonText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 18,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  name: { fontSize: 15, fontWeight: '700', color: '#0a0a0a', flexShrink: 1 },
  rating: { fontSize: 13, color: '#ec4899', letterSpacing: 1 },
  reviewText: { marginTop: 12, fontSize: 14, lineHeight: 20, color: '#444' },
  closeButton: {
    marginTop: 16,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: '#ec4899',
    alignItems: 'center',
  },
  closeButtonText: { fontSize: 13, fontWeight: '600', color: '#fff' },
});
