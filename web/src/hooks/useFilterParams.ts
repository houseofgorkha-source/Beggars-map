import { useEffect, useState } from 'react';

// Deliberately only the five dimensions the sitemap generator/App.tsx
// filtering actually use (cuisine, dish, mealType, location, price). A
// `search`/`selectedListing` param was drafted here but never wired to
// anything (the existing free-text search box and listing-selection popup
// are untouched, per scope) — kept out entirely rather than left as dead,
// unused surface area in the type.
export interface FilterParams {
  cuisine?: string;
  dish?: string;
  mealType?: string;
  location?: string;
  price?: string;
}

export function useFilterParams(): [FilterParams, (params: Partial<FilterParams>) => void] {
  const [params, setParams] = useState<FilterParams>(() => parseQueryParams());

  function parseQueryParams(): FilterParams {
    const sp = new URLSearchParams(window.location.search);
    return {
      cuisine: sp.get('cuisine') ?? undefined,
      dish: sp.get('dish') ?? undefined,
      mealType: sp.get('mealType') ?? undefined,
      location: sp.get('location') ?? undefined,
      price: sp.get('price') ?? undefined,
    };
  }

  function updateParams(newParams: Partial<FilterParams>) {
    const merged = { ...params, ...newParams };
    const sp = new URLSearchParams();

    if (merged.cuisine) sp.set('cuisine', merged.cuisine);
    if (merged.dish) sp.set('dish', merged.dish);
    if (merged.mealType) sp.set('mealType', merged.mealType);
    if (merged.location) sp.set('location', merged.location);
    if (merged.price) sp.set('price', merged.price);

    const newUrl = sp.toString() ? `?${sp.toString()}` : '/';
    window.history.replaceState({}, '', newUrl);
    setParams(merged);
  }

  // Sync when URL changes (e.g., browser back button)
  useEffect(() => {
    const handlePopState = () => {
      setParams(parseQueryParams());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return [params, updateParams];
}
