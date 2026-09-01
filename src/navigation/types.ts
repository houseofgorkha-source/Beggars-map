export type RootStackParamList = {
  Tabs: undefined;
  ListingDetail: { listingId: string };
  AddListing: { pickedLatitude?: number; pickedLongitude?: number } | undefined;
  PickLocation: { initialLatitude?: number; initialLongitude?: number };
  SignIn: undefined;
  Legal: { tab?: 'privacy' | 'terms' } | undefined;
  Leaderboard: undefined;
  About: undefined;
};

export type TabParamList = {
  Map: undefined;
  Profile: undefined;
};
