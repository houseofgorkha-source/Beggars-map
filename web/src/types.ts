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

export type ListingPhoto = {
  id: string;
  listing_id: string;
  photo_url: string;
  storage_path: string;
  position: number;
  created_at: string;
};
