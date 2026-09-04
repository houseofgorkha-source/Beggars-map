// Matches PUBLIC_LISTING_COLUMNS (lib/supabase.ts) exactly — every field the
// public anon/authenticated client actually has a column-level SELECT grant
// on. Admin-only columns (is_hidden, source, verification_status,
// reviewed_by, location_source, etc.) are deliberately absent here: the web
// app's queries never receive them, and the admin panel has its own,
// separate Listing type (web/src/admin/lib/adminApi.ts) for the
// service-role-backed data it actually needs.
export type Listing = {
  id: string;
  created_by: string;
  name: string;
  note: string | null;
  price_rupees: number;
  photo_url: string | null;
  latitude: number;
  longitude: number;
  city: string;
  created_at: string;
  // Human-readable location descriptor (e.g. "100 Feet Road, Indiranagar",
  // or "Indiranagar, Bengaluru" when street-level data isn't available) —
  // resolved once at submission time (see reverseGeocode.ts), never
  // fabricated when geocoding can't resolve anything useful. latitude/
  // longitude remain the authoritative location; this is display-only.
  location_label: string | null;
  // Structured dish/price entries (migration 0020) — the source of truth for
  // what this place sells and at what price. `null` on every listing created
  // before that migration; those keep showing price_rupees alone. Typed as
  // unknown because it arrives as raw jsonb — always read it through
  // parseDishes() in lib/dishes.ts rather than casting.
  dishes: unknown;
  // The submitter's own 1-5 star rating, or null if they didn't rate it.
  rating: number | null;
};

export type ListingPhoto = {
  id: string;
  listing_id: string;
  photo_url: string;
  storage_path: string;
  position: number;
  created_at: string;
};
