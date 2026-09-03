export type Profile = {
  id: string;
  display_name: string;
  created_at: string;
};

// Every public query selects PUBLIC_LISTING_COLUMNS (lib/supabase.ts),
// which anon/authenticated hold a Postgres column-level SELECT grant on —
// admin/internal columns (is_hidden, source, verification_status,
// reviewed_by, etc.) are deliberately absent, since they're never actually
// returned to this app. location_label is also part of that grant but
// omitted here since no mobile screen displays it (mobile resolves its own
// address live via geocoding.ts instead — see AGENTS.md).
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
};

export type ListingWithVotes = Listing & {
  vote_count: number;
};

export type LeaderboardRow = {
  user_id: string;
  display_name: string;
  listing_count: number;
  review_count: number;
  score: number;
};
