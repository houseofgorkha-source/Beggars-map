// Pure, dependency-free helpers for structured dish/price entries
// (listings.dishes, migration 0020).
//
// Zero imports on purpose: this is the shared core of the Add Listing form's
// validation and the customer-facing display sentence, and it's unit tested
// under plain Node against BOTH platforms' copies at once (see
// tests/dishes.test.mjs) so web and mobile can't silently drift — the same
// convention placeRanking.ts and searchCache.ts already follow.
//
// The stored structure is the source of truth. The sentence a customer reads
// ("Masala Dosa ₹60, Rice Meals ₹80") is always DERIVED from it here and
// never stored anywhere, so the two can't disagree.

export type DishEntry = { dish: string; price: number };

// ₹30-₹100 per dish (2026-09-04 correction) — a floor was added because
// nothing previously stopped a single cheap item (a ₹10 vada, one roti)
// from becoming a listing's qualifying price just for being ≤₹100. Mirrors
// is_valid_dishes()/listings_dishes_shape in migration 0020 (amended in
// place, not a separate migration — see that file's own header) at the DB
// level.
export const MIN_DISH_PRICE = 30;
export const MAX_DISH_PRICE = 100;

// ---- Complete-meal qualification: FINAL MVP DECISION ----------------------
//
// 2026-09-04: this went through several designs in one day before landing
// here.
//   v1 required an explicit meal/thali/combo/breakfast keyword or a
//   connector (+, "and", "with") — ported from the discovery pipeline's
//   classifyOffering (tools/discovery/matching.mjs). Rejected: it blocked
//   perfectly normal entries like "Dosa ₹50" for lacking a magic word.
//   v2 replaced that with a 6-word exact-match blocklist (idli/vada/roti/
//   chapati/tea/coffee) plus quantity-prefix stripping. Rejected: it missed
//   anything not on the list ("2 boiled eggs"/"3 bananas"/"2 samosas").
//   v3 (self-declared "is this a full meal?" checkbox per row) was
//   proposed and planned, but rejected before being built.
//   v4 combined a bare-beverage check with a leading-quantity check (plus a
//   multi-item-connector escape hatch) — also rejected: the explicit,
//   final product decision was that NO wording/quantity-based rejection of
//   any kind belongs in this rule, full stop. Every one of these designs
//   trades away simplicity for edge cases that keep resurfacing; the
//   product call was to stop trying to infer intent from dish text
//   entirely.
//
// FINAL RULE: price range (₹30-₹100 inclusive) is the ONLY automatic
// qualification check. There is no meal/snack classifier, no blocklist, no
// keyword, quantity, or connector detection, no self-declaration checkbox.
// "Dosa ₹50", "Biryani ₹90", "1 Idli ₹30", "2 boiled eggs ₹30", and
// "Tea ₹30" are all valid dish entries under this rule. Questionable
// listings are handled through the existing report flow and admin
// moderation, not algorithmic food classification. tools/discovery/
// matching.mjs is unrelated and untouched — it judges secondhand discovery-
// research evidence, a different problem from a user describing their own
// listing.

export function isValidDishEntry(value: unknown): value is DishEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as { dish?: unknown; price?: unknown };
  if (typeof entry.dish !== 'string' || entry.dish.trim().length === 0) return false;
  if (typeof entry.price !== 'number' || !Number.isInteger(entry.price)) return false;
  return entry.price >= MIN_DISH_PRICE && entry.price <= MAX_DISH_PRICE;
}

// Defensive parse of whatever came back from the database. Anything that
// doesn't match the expected shape is dropped rather than rendered — a
// listing created before 0020 has `dishes = null` and simply has no
// breakdown, which every caller already handles by falling back to
// price_rupees.
export function parseDishes(value: unknown): DishEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isValidDishEntry)
    .map((entry) => ({ dish: entry.dish.trim(), price: entry.price }));
}

// The customer-facing plain-language rendering — explicitly not a table.
// "Masala Dosa ₹60, Rice Meals ₹80, Idli Vada ₹40"
export function formatDishes(entries: DishEntry[]): string {
  return entries.map((entry) => `${entry.dish} ₹${entry.price}`).join(', ');
}

// The listing's headline price stays price_rupees (the cheapest-first sort
// key and the ₹100 cap column), derived from the cheapest dish so the two
// can never disagree.
export function minDishPrice(entries: DishEntry[]): number | null {
  if (entries.length === 0) return null;
  return entries.reduce((lowest, entry) => (entry.price < lowest ? entry.price : lowest), entries[0].price);
}

export type DishDraft = { dish: string; price: string };

export const PRICE_RANGE_ERROR = `Price must be between ₹${MIN_DISH_PRICE} and ₹${MAX_DISH_PRICE}.`;

export type DishValidation =
  | { ok: true; entries: DishEntry[]; priceRupees: number }
  | { ok: false; error: string };

// Validates the Add Listing form's raw text inputs. Shared by both platforms
// so the rules (and the exact error copy) can't drift.
//
// A row left entirely blank is ignored rather than rejected — that's the
// natural state of an "+ Add more" row the user added and then changed their
// mind about, and failing on it would be hostile. A HALF-filled row is a
// real error, since it means the user meant to enter something.
export function validateDishDrafts(drafts: DishDraft[]): DishValidation {
  const entries: DishEntry[] = [];

  for (const draft of drafts) {
    const dish = draft.dish.trim();
    const rawPrice = draft.price.trim();
    if (dish.length === 0 && rawPrice.length === 0) continue;

    if (dish.length === 0) return { ok: false, error: 'Add a dish name for every price you enter.' };
    if (rawPrice.length === 0) return { ok: false, error: `Add a price for "${dish}".` };

    const price = Number(rawPrice);
    if (!Number.isFinite(price) || !Number.isInteger(price) || price <= 0) {
      return { ok: false, error: `Enter a whole rupee price for "${dish}".` };
    }
    if (price < MIN_DISH_PRICE || price > MAX_DISH_PRICE) {
      return { ok: false, error: PRICE_RANGE_ERROR };
    }

    entries.push({ dish, price });
  }

  if (entries.length === 0) return { ok: false, error: 'Add at least one dish and its price.' };

  const priceRupees = minDishPrice(entries);
  if (priceRupees == null) return { ok: false, error: 'Add at least one dish and its price.' };

  return { ok: true, entries, priceRupees };
}
