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

export type Review = {
  id: string;
  listing_id: string;
  created_by: string;
  comment: string | null;
  food_quality: number;
  hygiene: number;
  availability: number;
  maintenance: number;
  created_at: string;
};

export type ListingRating = {
  listing_id: string;
  avg_rating: number;
  rating_count: number;
};
