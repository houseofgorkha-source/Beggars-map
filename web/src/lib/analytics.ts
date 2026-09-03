// Thin wrapper over Plausible's global `window.plausible` (loaded via the
// script tag in index.html) — remediation plan P8-5's three conversion
// events (listing viewed, Add Listing opened, listing submitted), the
// growth loop the whole product actually depends on and, before this, had
// zero visibility into. Guarded because `plausible` may not exist: the
// script tag does nothing until beggarsmap.com is registered with an
// actual Plausible account (see index.html's own comment), and an ad
// blocker can strip the script entirely — this must never throw either way.
declare global {
  interface Window {
    plausible?: (event: string, options?: { props?: Record<string, string | number | boolean> }) => void;
  }
}

export function trackEvent(event: string, props?: Record<string, string | number | boolean>): void {
  try {
    window.plausible?.(event, props ? { props } : undefined);
  } catch {
    // Analytics must never break the app it's measuring.
  }
}
