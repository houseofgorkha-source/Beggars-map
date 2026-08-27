import { useState } from 'react';

type Props = {
  initialTab: 'privacy' | 'terms';
  onClose: () => void;
};

const LAST_UPDATED = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

export default function LegalModal({ initialTab, onClose }: Props) {
  const [tab, setTab] = useState<'privacy' | 'terms'>(initialTab);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal legal-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Legal</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="legal-tabs">
          <button className={`tab-button ${tab === 'privacy' ? 'active' : ''}`} onClick={() => setTab('privacy')}>Privacy Policy</button>
          <button className={`tab-button ${tab === 'terms' ? 'active' : ''}`} onClick={() => setTab('terms')}>Terms &amp; Conditions</button>
        </div>

        <div className="modal-body legal-body">
          <p className="legal-updated">Last updated {LAST_UPDATED}.</p>

          {tab === 'privacy' ? (
            <>
              <h3>What we collect</h3>
              <p><strong>On the web (no login):</strong> nothing about you personally — no email, no name, no password. Just a random anonymous session so your votes and reviews stay consistently yours across visits, without identifying you.</p>
              <p><strong>On the mobile app:</strong> your Google account email and display name, but only if you choose to sign in to post a listing or vote. Browsing never requires this.</p>
              <p><strong>Content you submit:</strong> listing name, price, photo, note, and location for spots you add; star ratings and comments on reviews; the reason if you report a listing.</p>
              <p><strong>Location:</strong> only used when you tap "use current location," to drop a pin or sort listings by distance. It's not stored beyond that action unless you deliberately submit it as a listing's location.</p>
              <p><strong>Photos:</strong> stored in our file storage and publicly visible, since listings are public by design — don't upload a photo with anything private in the background you wouldn't want public.</p>

              <h3>What we don't do</h3>
              <p>No ads, no ad trackers. No restaurant or business partnerships that influence what gets listed or how it's ranked — every listing is community-submitted and treated equally. No selling data, no data brokers.</p>

              <h3>Who your information is shared with</h3>
              <p>Only the infrastructure that makes the product work: Supabase (our database, authentication, and file storage provider), OLA Maps / Krutrim (map tiles and place search — receives your search text and approximate location when you use map features), and Google (mobile sign-in only, if you choose it).</p>

              <h3>Anonymous web sessions</h3>
              <p>The web app posts and votes without any login, using a silent per-visitor session with no personal data attached. This is the intended design for web, not a placeholder — browsing and contributing on web will keep working without sign-in.</p>

              <h3>Your rights</h3>
              <p>You can delete your own listings and reviews at any time directly from the app or site — look for "Delete my listing" / "Delete my review" on the listing you posted. On mobile (Google sign-in), you can also delete your entire account and everything tied to it from your Profile screen. Web contributions aren't tied to any personal information, so there's no separate identity to look up for a takedown request from an anonymous session — deleting the content yourself is the way to remove it. Questions or removal requests we can't handle in-app can go to the contact details below.</p>

              <h3>Cookies &amp; local storage</h3>
              <p>The web app uses browser local storage to remember your anonymous session. No advertising or third-party tracking cookies.</p>

              <h3>Contact</h3>
              <p>Questions about this policy or your data — call or WhatsApp <a href="tel:+919606002439">+91 96060 02439</a>.</p>

              <div className="legal-notice">
                <p className="legal-notice-title">A note on this document</p>
                <p>This policy was written to accurately describe what Beggars Map's product actually does, but it is not legal advice and has not been reviewed by a lawyer. India's DPDP Act, 2023 governs personal data handling for Indian users — we'd recommend a qualified review before treating this as a final compliance document.</p>
              </div>
            </>
          ) : (
            <>
              <h3>What Beggars Map is</h3>
              <p>A free, community-run directory of cheap eats (₹100 or under per plate/meal) in Bengaluru. Listings, prices, and reviews are submitted by users, not verified by us before they go live.</p>

              <h3>No warranty on listings</h3>
              <p>A listed spot could be closed, its price could have changed, or its hygiene/quality is only as good as what other users have self-reported. Always use your own judgement — Beggars Map is a directory, not a guarantee.</p>

              <h3>Acceptable use</h3>
              <p>Don't post listings that aren't real food/eatery spots, spam, fake reviews, or content you don't have the right to share. We use automated checks and manual review, and may remove content or restrict access that violates this.</p>

              <h3>Content you submit</h3>
              <p>You must own the rights to, or have permission to share, any photo or text you submit. By submitting it, you grant Beggars Map a license to display it within the app and site.</p>

              <h3>Liability</h3>
              <p>We're not responsible for your experience at any listed establishment, including food safety, pricing accuracy, or availability. Beggars Map only aggregates what the community submits.</p>

              <h3>Changes to these terms</h3>
              <p>We may update these terms as the product changes. Continuing to use Beggars Map after an update means you accept the revised terms.</p>

              <h3>Contact</h3>
              <p>Questions about these terms — call or WhatsApp <a href="tel:+919606002439">+91 96060 02439</a>.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
