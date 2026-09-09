import { MIN_DISH_PRICE, MAX_DISH_PRICE, type DishDraft } from '../lib/dishes';

type Props = {
  drafts: DishDraft[];
  onChange: (drafts: DishDraft[]) => void;
  error?: string | null;
  // Create mode requires at least one dish (the "(at least one required)"
  // hint); review mode's Add Review form pre-fills this from the listing's
  // existing dishes and treats an all-blank section as "no dishes
  // correction proposed", not an error — so that hint would be misleading
  // there. Defaults to true (create mode's existing behavior, unchanged).
  requireFirst?: boolean;
};

// The Dish + Price entry rows, extracted out of AddListingModal.tsx so it
// can be reused by the same component's own review mode without a second,
// driftable copy. Pure presentation; `validateDishDrafts` (lib/dishes.ts)
// stays the single source of truth for what's actually valid, called by
// whichever form owns the drafts.
export default function DishPriceRows({ drafts, onChange, error, requireFirst = true }: Props) {
  function updateDraft(index: number, patch: Partial<DishDraft>) {
    onChange(drafts.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  }
  function removeDraft(index: number) {
    onChange(drafts.filter((_, i) => i !== index));
  }
  function addMore() {
    onChange([...drafts, { dish: '', price: '' }]);
  }

  return (
    <>
      {drafts.map((draft, index) => (
        <div className="dish-entry" key={index}>
          {/* Only the added rows are removable — the first pair is the one
              a submission can't exist without. */}
          {index > 0 ? (
            <button type="button" className="dish-remove" onClick={() => removeDraft(index)} aria-label={`Remove dish ${index + 1}`}>
              ✕
            </button>
          ) : null}
          <div className="dish-price-labels">
            <label className="field-label dish-label">Dish{index === 0 && requireFirst ? ' (at least one required)' : ''}</label>
            <label className="field-label price-label">Price (₹ per plate)*</label>
          </div>
          <div className="dish-price-row">
            <div className="dish-field">
              <input
                className="text-input"
                value={draft.dish}
                onChange={(e) => updateDraft(index, { dish: e.target.value })}
                placeholder="e.g. Masala Dosa"
              />
            </div>
            <div className="price-field">
              <input
                className="text-input"
                value={draft.price}
                onChange={(e) => updateDraft(index, { price: e.target.value })}
                placeholder="60"
                type="number"
                min={MIN_DISH_PRICE}
                max={MAX_DISH_PRICE}
              />
            </div>
          </div>
        </div>
      ))}
      {/* One hint, always trailing the LAST row rather than anchored to row
          0, so it moves down (not sandwiched between rows) as more rows are
          added. */}
      <div className="dish-price-row">
        <div className="dish-field" />
        <div className="price-field">
          <span className="field-hint">
            *₹{MIN_DISH_PRICE}-₹{MAX_DISH_PRICE}
          </span>
        </div>
      </div>
      <button type="button" className="dish-add-more" onClick={addMore}>
        + Add more
      </button>
      {error ? <div className="error-text">{error}</div> : null}
    </>
  );
}
