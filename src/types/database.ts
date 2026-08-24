export type Profile = {
  id: string;
  display_name: string;
  created_at: string;
};

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
};

export type ListingWithVotes = Listing & {
  vote_count: number;
};

export type Review = {
  id: string;
  listing_id: string;
  created_by: string;
  comment: string | null;
  worth_it: boolean;
  created_at: string;
};

export type LeaderboardRow = {
  user_id: string;
  display_name: string;
  listing_count: number;
  review_count: number;
  score: number;
};
