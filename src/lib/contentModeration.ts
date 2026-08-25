// Lightweight heuristic to keep obviously non-food listings out — Beggars Map
// is cheap eats only, not a general classifieds board. Not foolproof (no LLM
// call yet), just catches the obvious cases like "cloth shop" or "salon".
const NON_FOOD_KEYWORDS = [
  'cloth', 'apparel', 'fashion', 'boutique', 'tailor', 'garment',
  'salon', 'spa', 'parlour', 'parlor', 'barber',
  'electronics', 'mobile shop', 'laptop', 'computer repair',
  'furniture', 'decor', 'interior design',
  'real estate', 'property', 'flat for rent', 'apartment for rent', 'pg for rent',
  'gym', 'fitness', 'yoga studio',
  'pharmacy', 'medical store', 'clinic', 'hospital',
  'jewelry', 'jewellery', 'jeweller',
  'laundry', 'dry clean',
  'bookstore', 'stationery',
  'hardware store', 'paint shop',
];

export function checkFoodRelevance(name: string, note: string): { ok: boolean; matchedTerm?: string } {
  const text = `${name} ${note}`.toLowerCase();
  const matched = NON_FOOD_KEYWORDS.find((kw) => text.includes(kw));
  return matched ? { ok: false, matchedTerm: matched } : { ok: true };
}
