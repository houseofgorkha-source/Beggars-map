import type { Listing } from '../types';
// Explicit .ts extension: Node's native type-stripping test runner (see
// tests/extractDimensions.test.mjs) requires a resolvable extension on
// relative ESM imports — an extensionless specifier resolves fine under
// Vite/tsc but throws ERR_MODULE_NOT_FOUND under plain `node --test`. Vite
// and tsc both still resolve this the same way with the extension present.
// tools/build/generate-sitemap.mjs (also plain Node) imports this exact
// file directly for the same reason — this is the single source of truth
// for dimension extraction; no duplicated copy exists anywhere else.
import { parseDishes } from './dishes.ts';

// Minimal keyword extraction for cuisines — keywords found in name, note, or
// dishes. Deliberately NO bare single-word 'north'/'south' entries: those
// were tested against real production data and, while no false positive
// existed yet, they're a structural risk (a note reading "south-facing
// entrance" or "north gate parking" would false-positive into a cuisine
// claim with no word-boundary/context check beyond plain substring
// matching). Removed rather than tightened with more compound phrases —
// adding narrower phrases tuned to today's specific listings would be
// overfitting to current data, not a general fix. The remaining compound
// phrases ('north indian', 'punjabi', 'south indian', 'dosa', etc.) are
// specific enough not to false-positive on unrelated context.
const CUISINE_KEYWORDS: Record<string, string[]> = {
  'north-indian': ['north indian', 'punjabi', 'punjab', 'chole bhature', 'kulcha', 'parathas', 'butter chicken', 'dal makhani'],
  'south-indian': ['south indian', 'dosa', 'idli', 'udipi', 'karnataka', 'tamil', 'kerala', 'andhra', 'sambar'],
  'bengali': ['bengali', 'bengal', 'kolkata'],
  'gujarati': ['gujarati', 'dhokla', 'fafda', 'khichdi', 'gujarath'],
  'chole-bhature': ['chole bhature', 'chole', 'bhature'],
  'biryani': ['biryani', 'hyderabadi'],
  'chinese': ['chinese', 'indo-chinese', 'hakka'],
  'street-food': ['street food', 'chaat', 'pani puri', 'vada pav', 'samosa', 'fritters'],
};

const MEAL_TYPE_KEYWORDS: Record<string, string[]> = {
  'breakfast': ['breakfast', 'idli', 'vada', 'dosa', 'poha', 'upma'],
  'lunch': ['lunch', 'meal', 'rice meal', 'plate', 'lunch thali'],
  'dinner': ['dinner', 'evening'],
  'thali': ['thali', 'combo', 'combo meal'],
};

// Normalize and lowercase for matching
function normalizeText(text: string): string {
  return text.toLowerCase().trim();
}

function textMatches(text: string, keywords: string[]): boolean {
  const norm = normalizeText(text);
  return keywords.some((kw) => norm.includes(normalizeText(kw)));
}

// Extract all unique cuisines from a listing
export function extractCuisines(listing: Listing): string[] {
  const found = new Set<string>();
  const searchText = `${listing.name} ${listing.note || ''}`.toLowerCase();
  const dishes = parseDishes(listing.dishes);

  for (const [cuisine, keywords] of Object.entries(CUISINE_KEYWORDS)) {
    if (textMatches(searchText, keywords)) {
      found.add(cuisine);
    }
    for (const dish of dishes) {
      if (textMatches(dish.dish, keywords)) {
        found.add(cuisine);
        break;
      }
    }
  }

  return Array.from(found).sort();
}

// Extract all unique meal types from a listing
export function extractMealTypes(listing: Listing): string[] {
  const found = new Set<string>();
  const searchText = `${listing.name} ${listing.note || ''}`.toLowerCase();
  const dishes = parseDishes(listing.dishes);

  for (const [mealType, keywords] of Object.entries(MEAL_TYPE_KEYWORDS)) {
    if (textMatches(searchText, keywords)) {
      found.add(mealType);
    }
    for (const dish of dishes) {
      if (textMatches(dish.dish, keywords)) {
        found.add(mealType);
        break;
      }
    }
  }

  return Array.from(found).sort();
}

// Extract all unique dishes from a listing (normalized names only)
export function extractDishNames(listing: Listing): string[] {
  const dishes = parseDishes(listing.dishes);
  return dishes
    .map((d) => normalizeText(d.dish))
    .filter((d, i, arr) => arr.indexOf(d) === i) // dedupe
    .sort();
}

// Extract locality from location_label (e.g., "7th Main Road, Indiranagar" → "Indiranagar")
export function extractLocality(listing: Listing): string | null {
  if (!listing.location_label) return null;
  const parts = listing.location_label.split(',').map((p) => p.trim());
  // Return the last non-empty part (usually the area/neighborhood)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]) return normalizeText(parts[i]);
  }
  return null;
}

// Cumulative price ceilings, consistent with Beggars Map's ₹100-or-less
// positioning: 'under-50' means price <= ₹50, 'under-75' means price <= ₹75
// (a SUPERSET of under-50, not a 51-75 slice), 'under-100' means price <=
// ₹100 (a superset of both). These are NOT mutually-exclusive bands — a
// single ₹40 listing genuinely belongs to all three. This deliberately
// means '?price=under-100' matches the entire catalog, since every listing
// is already <=₹100 by the DB's own price-cap constraint (0004_price_cap.sql)
// — that's correct, not a bug: "under ₹100" should mean literally everything
// on a site whose entire premise is "₹100 or less".
export const PRICE_BANDS = ['under-50', 'under-75', 'under-100'] as const;
export type PriceBand = (typeof PRICE_BANDS)[number];

const PRICE_THRESHOLDS: Record<PriceBand, number> = {
  'under-50': 50,
  'under-75': 75,
  'under-100': 100,
};

// Every price band this listing's price qualifies for, cumulative.
export function getPriceRanges(listing: Listing): PriceBand[] {
  return PRICE_BANDS.filter((band) => listing.price_rupees <= PRICE_THRESHOLDS[band]);
}

// Whether this listing's price clears a given band's ceiling. Unknown band
// values (never produced by this module, but a caller could pass anything)
// never match — never guessed.
export function matchesPriceRange(listing: Listing, band: string): boolean {
  const threshold = PRICE_THRESHOLDS[band as PriceBand];
  if (threshold === undefined) return false;
  return listing.price_rupees <= threshold;
}

// Build aggregate dimension index from all listings
export interface DimensionIndex {
  cuisines: Record<string, number>; // cuisine name → count of listings
  mealTypes: Record<string, number>;
  dishes: Record<string, number>;
  localities: Record<string, number>;
  priceRanges: Record<string, number>;
}

export function buildDimensionIndex(listings: Listing[]): DimensionIndex {
  const index: DimensionIndex = {
    cuisines: {},
    mealTypes: {},
    dishes: {},
    localities: {},
    priceRanges: {},
  };

  for (const listing of listings) {
    for (const cuisine of extractCuisines(listing)) {
      index.cuisines[cuisine] = (index.cuisines[cuisine] ?? 0) + 1;
    }
    for (const mealType of extractMealTypes(listing)) {
      index.mealTypes[mealType] = (index.mealTypes[mealType] ?? 0) + 1;
    }
    for (const dish of extractDishNames(listing)) {
      index.dishes[dish] = (index.dishes[dish] ?? 0) + 1;
    }
    const locality = extractLocality(listing);
    if (locality) {
      index.localities[locality] = (index.localities[locality] ?? 0) + 1;
    }
    // Cumulative: a single listing increments every band it qualifies for,
    // not just one — see getPriceRanges.
    for (const priceRange of getPriceRanges(listing)) {
      index.priceRanges[priceRange] = (index.priceRanges[priceRange] ?? 0) + 1;
    }
  }

  return index;
}

// Filter listings by a single dimension (generic to preserve listing type)
export function filterByDimension<T extends Listing>(
  listings: T[],
  dimensionType: 'cuisine' | 'meal-type' | 'dish' | 'locality' | 'price-range',
  value: string
): T[] {
  return listings.filter((listing) => {
    const norm = normalizeText(value);
    switch (dimensionType) {
      case 'cuisine':
        return extractCuisines(listing).includes(norm);
      case 'meal-type':
        return extractMealTypes(listing).includes(norm);
      case 'dish':
        return extractDishNames(listing).includes(norm);
      case 'locality':
        return extractLocality(listing) === norm;
      case 'price-range':
        return matchesPriceRange(listing, norm);
    }
  });
}

// The per-listing tag-set shape the sitemap generator's combination
// discovery consumes (tools/build/combinationDiscovery.mjs) — every
// dimension represented uniformly as "the array of values this listing
// carries for that dimension" (locality is naturally 0-or-1 elements,
// price is the cumulative bands above, the rest are their natural arrays).
// Exported from here so there is exactly one place that defines how a
// listing's tags are derived, reused by both the single-dimension sitemap
// loops and the multi-dimension combination discoverer.
export interface ListingTags {
  cuisine: string[];
  mealType: string[];
  dish: string[];
  locality: string[];
  price: string[];
}

export function extractListingTags(listing: Listing): ListingTags {
  const locality = extractLocality(listing);
  return {
    cuisine: extractCuisines(listing),
    mealType: extractMealTypes(listing),
    dish: extractDishNames(listing),
    locality: locality ? [locality] : [],
    price: getPriceRanges(listing),
  };
}

// Normalize a dimension value for URL/UI consistency
export function normalizeDimensionValue(value: string, dimensionType: string): string {
  return normalizeText(value).replace(/\s+/g, '-');
}

// Denormalize a dimension value from URL to display
export function denormalizeDimensionValue(value: string): string {
  return value
    .replace(/^(.)/, (c) => c.toUpperCase()) // capitalize first letter
    .replace(/-([a-z])/g, (match, letter) => ` ${letter.toUpperCase()}`) // capitalize after dash
    .replace(/-/g, ' '); // replace remaining dashes with spaces
}
