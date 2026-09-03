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
};

export type ListingPhoto = {
  id: string;
  listing_id: string;
  photo_url: string;
  storage_path: string;
  position: number;
  created_at: string;
};
