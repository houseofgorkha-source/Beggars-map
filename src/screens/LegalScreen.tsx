import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../navigation/types';

type LegalRoute = RouteProp<RootStackParamList, 'Legal'>;

const LAST_UPDATED = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

function Section({ title, children }: { title: string; children: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionBody}>{children}</Text>
    </View>
  );
}

export default function LegalScreen() {
  const { params } = useRoute<LegalRoute>();
  const [tab, setTab] = useState<'privacy' | 'terms'>(params?.tab ?? 'privacy');

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        <Pressable style={[styles.tabButton, tab === 'privacy' && styles.tabButtonActive]} onPress={() => setTab('privacy')}>
          <Text style={[styles.tabText, tab === 'privacy' && styles.tabTextActive]}>Privacy Policy</Text>
        </Pressable>
        <Pressable style={[styles.tabButton, tab === 'terms' && styles.tabButtonActive]} onPress={() => setTab('terms')}>
          <Text style={[styles.tabText, tab === 'terms' && styles.tabTextActive]}>Terms &amp; Conditions</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.updated}>Last updated {LAST_UPDATED}.</Text>

        {tab === 'privacy' ? (
          <>
            <Section title="What we collect">
              {'On the web (no login): nothing about you personally — no email, no name, no password. Just a random anonymous session so your votes stay consistently yours across visits, without identifying you.\n\nOn the mobile app: your Google account email and display name, but only if you choose to sign in to post a listing or vote. Browsing never requires this.\n\nContent you submit: listing name, price, photo, note, and location for spots you add; whether you found a listing worth it; the reason if you report a listing.\n\nLocation: only used when you tap "use current location," to drop a pin or sort listings by distance. It\'s not stored beyond that action unless you deliberately submit it as a listing\'s location.\n\nPhotos: stored in our file storage and publicly visible, since listings are public by design — don\'t upload a photo with anything private in the background you wouldn\'t want public.'}
            </Section>
            <Section title="What we don't do">
              {"No ads, no ad trackers. No restaurant or business partnerships that influence what gets listed or how it's ranked — every listing is community-submitted and treated equally. No selling data, no data brokers."}
            </Section>
            <Section title="Who your information is shared with">
              {'Only the infrastructure that makes the product work: Supabase (our database, authentication, and file storage provider), OLA Maps / Krutrim (map tiles and place search — receives your search text and approximate location when you use map features), and Google (mobile sign-in only, if you choose it).'}
            </Section>
            <Section title="Anonymous web sessions">
              {"The web app posts and votes without any login, using a silent per-visitor session with no personal data attached. This is the intended design for web, not a placeholder — browsing and contributing on web will keep working without sign-in."}
            </Section>
            <Section title="Your rights">
              {'You can delete your own listings and reviews at any time directly from the app or site — look for "Delete my listing" / "Delete my review" on the listing you posted. On mobile (Google sign-in), you can also delete your entire account and everything tied to it from your Profile screen. Web contributions aren\'t tied to any personal information, so there\'s no separate identity to look up for a takedown request from an anonymous session — deleting the content yourself is the way to remove it. Questions or removal requests we can\'t handle in-app can go to the contact details below.'}
            </Section>
            <Section title="Cookies &amp; local storage">
              {'The web app uses browser local storage to remember your anonymous session. No advertising or third-party tracking cookies.'}
            </Section>
            <Section title="Contact">
              {'Questions about this policy or your data — call or WhatsApp +91 96060 02439.'}
            </Section>
            <Pressable onPress={() => Linking.openURL('tel:+919606002439')}>
              <Text style={styles.link}>Call +91 96060 02439</Text>
            </Pressable>
            <Pressable onPress={() => Linking.openURL('https://wa.me/919606002439')}>
              <Text style={styles.link}>WhatsApp us</Text>
            </Pressable>

            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>A note on this document</Text>
              <Text style={styles.noticeBody}>
                This policy was written to accurately describe what Beggars Map's product actually does, but it is not legal advice and has not been reviewed by a lawyer. India's DPDP Act, 2023 governs personal data handling for Indian users — we'd recommend a qualified review before treating this as a final compliance document.
              </Text>
            </View>
          </>
        ) : (
          <>
            <Section title="What Beggars Map is">
              {'A free, community-run directory of affordable eats (₹100 or under per plate/meal) in Bengaluru. Listings, prices, and reviews are submitted by users, not verified by us before they go live.'}
            </Section>
            <Section title="No warranty on listings">
              {"A listed spot could be closed, its price could have changed, or its hygiene/quality is only as good as what other users have self-reported. Always use your own judgement — Beggars Map is a directory, not a guarantee."}
            </Section>
            <Section title="Acceptable use">
              {"Don't post listings that aren't real food/eatery spots, spam, fake reviews, or content you don't have the right to share. We use automated checks and manual review, and may remove content or restrict access that violates this."}
            </Section>
            <Section title="Content you submit">
              {'You must own the rights to, or have permission to share, any photo or text you submit. By submitting it, you grant Beggars Map a license to display it within the app and site.'}
            </Section>
            <Section title="Liability">
              {"We're not responsible for your experience at any listed establishment, including food safety, pricing accuracy, or availability. Beggars Map only aggregates what the community submits."}
            </Section>
            <Section title="Changes to these terms">
              {'We may update these terms as the product changes. Continuing to use Beggars Map after an update means you accept the revised terms.'}
            </Section>
            <Section title="Contact">
              {'Questions about these terms — call or WhatsApp +91 96060 02439.'}
            </Section>
            <Pressable onPress={() => Linking.openURL('tel:+919606002439')}>
              <Text style={styles.link}>Call +91 96060 02439</Text>
            </Pressable>
            <Pressable onPress={() => Linking.openURL('https://wa.me/919606002439')}>
              <Text style={styles.link}>WhatsApp us</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  tabs: { flexDirection: 'row', gap: 8, padding: 16, paddingBottom: 8 },
  tabButton: { flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 20, paddingVertical: 8, alignItems: 'center' },
  tabButtonActive: { backgroundColor: '#ec4899', borderColor: '#ec4899' },
  tabText: { fontSize: 13, fontWeight: '600', color: '#333' },
  tabTextActive: { color: '#fff' },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 48 },
  updated: { color: '#888', fontSize: 12, marginBottom: 12 },
  section: { marginBottom: 18 },
  sectionTitle: { fontSize: 15, fontWeight: '700', marginBottom: 6 },
  sectionBody: { fontSize: 14, lineHeight: 21, color: '#333' },
  link: { color: '#ec4899', fontWeight: '600', marginBottom: 8 },
  notice: {
    marginTop: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#f0d98c',
    backgroundColor: '#fff9e8',
    borderRadius: 10,
  },
  noticeTitle: { fontWeight: '700', marginBottom: 4 },
  noticeBody: { fontSize: 13, lineHeight: 19, color: '#555' },
});
