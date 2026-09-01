import { ScrollView, StyleSheet, Text, View } from 'react-native';

export default function AboutScreen() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { paddingBottom: 32 },
  about: { padding: 24, alignItems: 'center' },
  aboutTitle: { fontSize: 24, fontWeight: '900', marginBottom: 12, textAlign: 'center' },
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
