export type RootStackParamList = {
  Tabs: undefined;
  ListingDetail: { listingId: string };
  AddListing: { pickedLatitude?: number; pickedLongitude?: number } | undefined;
  PickLocation: { initialLatitude?: number; initialLongitude?: number };
  SignIn: undefined;
};

export type TabParamList = {
  Map: undefined;
  Contribute: undefined;
  Leaderboard: undefined;
  Profile: undefined;
};
