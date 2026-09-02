// Discovery pipeline configuration: search areas + query categories.
// Bengaluru only, per the current scope. Coordinates are approximate
// neighborhood centers used only as a locationBias hint for Google's Text
// Search — never stored as a candidate's authoritative location (each
// candidate's own place.location from the API response is what's kept).

export const CITY = 'Bengaluru';

// Full city-wide area list (Phase 1.8, 2026-09-01) — the original 4 areas
// (Koramangala/Indiranagar/Jayanagar/Malleswaram, all South/Central) are
// kept first for backward-compat with `--areas=N` prefix slicing and with
// the 127-candidate dataset already discovered from them; everything after
// is new, covering North/East/West/Southeast/etc. zones that dataset has
// zero representation from. `zone` is metadata only (reporting/selection),
// never sent to the API.
export const AREAS = [
  { name: 'Koramangala', lat: 12.9352, lng: 77.6245, zone: 'South' },
  { name: 'Indiranagar', lat: 12.9784, lng: 77.6408, zone: 'Northeast' },
  { name: 'Jayanagar', lat: 12.925, lng: 77.5938, zone: 'South' },
  { name: 'Malleswaram', lat: 13.0027, lng: 77.571, zone: 'Central' },

  // Central
  { name: 'Frazer Town', lat: 12.9986, lng: 77.6122, zone: 'Central' },
  { name: 'Shivajinagar', lat: 12.9857, lng: 77.6057, zone: 'Central' },
  { name: 'Ulsoor', lat: 12.9815, lng: 77.622, zone: 'Central' },

  // North
  { name: 'Hebbal', lat: 13.0358, lng: 77.597, zone: 'North' },
  { name: 'Yeshwanthpur', lat: 13.0284, lng: 77.5541, zone: 'North' },
  { name: 'RT Nagar', lat: 13.0198, lng: 77.5946, zone: 'North' },
  { name: 'Hennur', lat: 13.045, lng: 77.635, zone: 'North' },
  { name: 'Kalyan Nagar', lat: 13.0234, lng: 77.6408, zone: 'North' },

  // Northeast
  { name: 'Kammanahalli', lat: 13.014, lng: 77.636, zone: 'Northeast' },
  { name: 'Domlur', lat: 12.961, lng: 77.6387, zone: 'Northeast' },

  // East
  { name: 'Whitefield', lat: 12.9698, lng: 77.75, zone: 'East' },
  { name: 'KR Puram', lat: 13.006, lng: 77.697, zone: 'East' },
  { name: 'Marathahalli', lat: 12.9569, lng: 77.7011, zone: 'East' },
  { name: 'Mahadevapura', lat: 12.984, lng: 77.696, zone: 'East' },
  { name: 'Kadugodi', lat: 12.993, lng: 77.762, zone: 'East' },

  // Southeast
  { name: 'Bellandur', lat: 12.926, lng: 77.6762, zone: 'Southeast' },
  { name: 'HSR Layout', lat: 12.9121, lng: 77.6446, zone: 'Southeast' },
  { name: 'Bommanahalli', lat: 12.902, lng: 77.615, zone: 'Southeast' },
  { name: 'Begur', lat: 12.872, lng: 77.628, zone: 'Southeast' },
  { name: 'Electronic City', lat: 12.8452, lng: 77.6602, zone: 'Southeast' },
  { name: 'Bommasandra', lat: 12.806, lng: 77.69, zone: 'Southeast' },

  // South
  { name: 'BTM Layout', lat: 12.9166, lng: 77.6101, zone: 'South' },
  { name: 'JP Nagar', lat: 12.9082, lng: 77.5855, zone: 'South' },
  { name: 'Banashankari', lat: 12.9081, lng: 77.5571, zone: 'South' },
  { name: 'Basavanagudi', lat: 12.9422, lng: 77.576, zone: 'South' },

  // West
  { name: 'Rajajinagar', lat: 12.9911, lng: 77.5529, zone: 'West' },
  { name: 'Vijayanagar', lat: 12.9719, lng: 77.534, zone: 'West' },
  { name: 'Nagarbhavi', lat: 12.959, lng: 77.503, zone: 'West' },

  // Southwest
  { name: 'Kengeri', lat: 12.907, lng: 77.485, zone: 'Southwest' },

  // Northwest
  { name: 'Peenya', lat: 13.028, lng: 77.52, zone: 'Northwest' },
  { name: 'Dasarahalli', lat: 13.0432, lng: 77.5222, zone: 'Northwest' },
];

// Ordered so that `--categories=N` picks the most food-specific, most
// likely-to-surface-an-affordable-COMPLETE-MEAL terms first (Phase 1.8,
// 2026-09-01 — expanded from the original 13 per the corrected "complete
// meal, not any cheap item" product scope; reordered + broadened Phase 1.9
// same day so the first 22 form a clean high-priority prefix — momos/street
// food/cheap eats added per "use your intelligence" to cover non-South-
// Indian affordable complete meals too, not just darshini-style places —
// and the more generic/expensive-to-run terms (bare "restaurant" searches)
// are pushed to the end, excluded from a curated `--categories=22` run).
// Google Places `INEXPENSIVE` remains a discovery signal only, never proof
// of ≤₹100 — unchanged.
export const QUERY_CATEGORIES = [
  'darshini',
  'tiffin',
  'mess',
  'meals',
  'thali',
  'bhojanalaya',
  'canteen',
  'military hotel',
  'udupi restaurant',
  'South Indian breakfast',
  'North Indian meals',
  'Punjabi meals',
  'Kerala meals',
  'Andhra meals',
  'Karnataka meals',
  'biryani',
  'chicken meals',
  'affordable breakfast',
  'budget meals',
  'momos',
  'street food',
  'cheap eats',
  // --- generic/lower-priority tail, excluded from a curated run ---
  'student canteen',
  'dosa',
  'South Indian restaurant',
  'North Indian restaurant',
  'vegetarian restaurant',
  'restaurants',
];

// Radius (meters) for the locationBias circle around each area's center.
export const SEARCH_RADIUS_METERS = 3000;

// Results requested per (area, query) call. Text Search (New) caps this at 20.
export const RESULTS_PER_QUERY = 10;

// Conservative defaults for an un-flagged run, per the "small initial run,
// do not immediately consume thousands of API calls" requirement. Override
// with --areas=N / --categories=N / --max-results=N / --all.
export const DEFAULT_AREA_COUNT = 4;
export const DEFAULT_CATEGORY_COUNT = 4;
