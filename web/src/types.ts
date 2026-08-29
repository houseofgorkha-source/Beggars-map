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
  is_hidden: boolean;
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
